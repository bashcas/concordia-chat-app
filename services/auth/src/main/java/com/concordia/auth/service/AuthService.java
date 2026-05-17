package com.concordia.auth.service;

import com.concordia.auth.dto.*;
import com.concordia.auth.exception.DuplicateResourceException;
import com.concordia.auth.exception.InvalidCredentialsException;
import com.concordia.auth.exception.InvalidTokenException;
import com.concordia.auth.model.RefreshToken;
import com.concordia.auth.model.User;
import com.concordia.auth.repository.RefreshTokenRepository;
import com.concordia.auth.repository.UserRepository;
import com.concordia.audit.AuditEmitter;
import com.concordia.audit.EventTypes;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.SignatureAlgorithm;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.Key;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.ZonedDateTime;
import java.util.Base64;
import java.util.Date;
import java.util.Map;
import java.util.UUID;

@Service
public class AuthService {

    private final UserRepository userRepository;
    private final RefreshTokenRepository refreshTokenRepository;
    private final PasswordEncoder passwordEncoder;
    private final KafkaTemplate<String, Object> kafkaTemplate;
    private final AuditEmitter auditEmitter;

    @Value("${jwt.secret}")
    private String jwtSecret;

    public AuthService(UserRepository userRepository, RefreshTokenRepository refreshTokenRepository, PasswordEncoder passwordEncoder, KafkaTemplate<String, Object> kafkaTemplate, AuditEmitter auditEmitter) {
        this.userRepository = userRepository;
        this.refreshTokenRepository = refreshTokenRepository;
        this.passwordEncoder = passwordEncoder;
        this.kafkaTemplate = kafkaTemplate;
        this.auditEmitter = auditEmitter;
    }

    public RegisterResponse registerUser(RegisterRequest request) {
        if (userRepository.existsByEmail(request.getEmail())) {
            throw new DuplicateResourceException("email already registered");
        }
        if (userRepository.existsByUsername(request.getUsername())) {
            throw new DuplicateResourceException("username already taken");
        }

        User user = new User();
        user.setId(UUID.randomUUID());
        user.setUsername(request.getUsername());
        user.setEmail(request.getEmail());
        user.setPasswordHash(passwordEncoder.encode(request.getPassword()));
        user.setCreatedAt(ZonedDateTime.now());
        user.setUpdatedAt(ZonedDateTime.now());

        userRepository.save(user);

        UserRegisteredEvent event = new UserRegisteredEvent(user.getId(), user.getUsername(), user.getEmail(), user.getCreatedAt());
        kafkaTemplate.send("user-registered", user.getId().toString(), event);

        auditEmitter.emit(EventTypes.AUTH_REGISTER,
                Map.of("user_id", user.getId().toString()),
                Map.of("type", "user", "id", user.getId().toString()),
                EventTypes.SUCCESS,
                Map.of("username", user.getUsername()));

        return new RegisterResponse(user.getId(), user.getUsername());
    }

    public LoginResponse login(LoginRequest request) {
        User user = userRepository.findByEmail(request.getEmail())
                .orElseThrow(() -> {
                    auditEmitter.emit(EventTypes.AUTH_LOGIN_FAILURE,
                            Map.of(), null, EventTypes.FAILURE,
                            Map.of("email", request.getEmail(), "reason", "user not found"));
                    return new InvalidCredentialsException("invalid credentials");
                });

        if (!passwordEncoder.matches(request.getPassword(), user.getPasswordHash())) {
            auditEmitter.emit(EventTypes.AUTH_LOGIN_FAILURE,
                    Map.of("user_id", user.getId().toString()), null, EventTypes.FAILURE,
                    Map.of("email", request.getEmail(), "reason", "bad password"));
            throw new InvalidCredentialsException("invalid credentials");
        }

        int expiresIn = 900; // 15 minutes
        Date now = new Date();
        Date expiryDate = new Date(now.getTime() + expiresIn * 1000L);

        Key key = Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8));
        String accessToken = Jwts.builder()
                .setSubject(user.getId().toString())
                .claim("username", user.getUsername())
                .setIssuedAt(now)
                .setExpiration(expiryDate)
                .signWith(key, SignatureAlgorithm.HS256)
                .compact();

        UUID rawRefreshToken = UUID.randomUUID();
        String tokenHash = hashToken(rawRefreshToken.toString());

        RefreshToken refreshToken = new RefreshToken();
        refreshToken.setId(UUID.randomUUID());
        refreshToken.setUserId(user.getId());
        refreshToken.setTokenHash(tokenHash);
        refreshToken.setExpiresAt(ZonedDateTime.now().plusDays(7));
        refreshToken.setCreatedAt(ZonedDateTime.now());
        
        refreshTokenRepository.save(refreshToken);

        auditEmitter.emit(EventTypes.AUTH_LOGIN_SUCCESS,
                Map.of("user_id", user.getId().toString()), null, EventTypes.SUCCESS, Map.of());

        return new LoginResponse(accessToken, rawRefreshToken.toString(), expiresIn);
    }

    public LoginResponse refresh(RefreshTokenRequest request) {
        String tokenHash = hashToken(request.getRefreshToken());
        RefreshToken oldToken = refreshTokenRepository.findByTokenHash(tokenHash)
                .orElseThrow(() -> new InvalidTokenException("invalid token"));

        if (oldToken.getExpiresAt().isBefore(ZonedDateTime.now())) {
            refreshTokenRepository.delete(oldToken);
            throw new InvalidTokenException("refresh token expired");
        }

        // Delete old token immediately (one-time use rotation)
        refreshTokenRepository.delete(oldToken);

        User user = userRepository.findById(oldToken.getUserId())
                .orElseThrow(() -> new InvalidTokenException("invalid token"));

        int expiresIn = 900; // 15 minutes
        Date now = new Date();
        Date expiryDate = new Date(now.getTime() + expiresIn * 1000L);

        Key key = Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8));
        String accessToken = Jwts.builder()
                .setSubject(user.getId().toString())
                .claim("username", user.getUsername())
                .setIssuedAt(now)
                .setExpiration(expiryDate)
                .signWith(key, SignatureAlgorithm.HS256)
                .compact();

        UUID rawRefreshToken = UUID.randomUUID();
        String newTokenHash = hashToken(rawRefreshToken.toString());

        RefreshToken newRefreshToken = new RefreshToken();
        newRefreshToken.setId(UUID.randomUUID());
        newRefreshToken.setUserId(user.getId());
        newRefreshToken.setTokenHash(newTokenHash);
        newRefreshToken.setExpiresAt(ZonedDateTime.now().plusDays(7));
        newRefreshToken.setCreatedAt(ZonedDateTime.now());

        refreshTokenRepository.save(newRefreshToken);

        auditEmitter.emit(EventTypes.AUTH_TOKEN_REFRESH,
                Map.of("user_id", user.getId().toString()), null, EventTypes.SUCCESS, Map.of());

        return new LoginResponse(accessToken, rawRefreshToken.toString(), expiresIn);
    }

    @org.springframework.transaction.annotation.Transactional
    public void logout(String authHeader) {
        UUID userId = extractUserId(authHeader);
        refreshTokenRepository.deleteByUserId(userId);
        auditEmitter.emit(EventTypes.AUTH_LOGOUT,
                Map.of("user_id", userId.toString()), null, EventTypes.SUCCESS, Map.of());
    }

    public UserProfileResponse getMe(String authHeader) {
        UUID userId = extractUserId(authHeader);
        User user = userRepository.findById(userId)
                .orElseThrow(() -> new InvalidTokenException("invalid token"));
        
        return new UserProfileResponse(
                user.getId(),
                user.getUsername(),
                user.getEmail(),
                user.getCreatedAt()
        );
    }

    private UUID extractUserId(String authHeader) {
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            throw new InvalidTokenException("unauthorized");
        }
        String token = authHeader.substring(7);
        try {
            Key key = Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8));
            String userIdStr = Jwts.parserBuilder()
                    .setSigningKey(key)
                    .build()
                    .parseClaimsJws(token)
                    .getBody()
                    .getSubject();
            return UUID.fromString(userIdStr);
        } catch (Exception e) {
            throw new InvalidTokenException("invalid token");
        }
    }

    private String hashToken(String token) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(token.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 algorithm not found", e);
        }
    }
}
