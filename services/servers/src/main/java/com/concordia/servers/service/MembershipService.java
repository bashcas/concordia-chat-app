package com.concordia.servers.service;

import com.concordia.servers.model.Membership;
import com.concordia.servers.model.MembershipId;
import com.concordia.servers.model.Server;
import com.concordia.servers.repository.MembershipRepository;
import com.concordia.servers.repository.ServerRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import com.concordia.servers.model.UserCache;
import com.concordia.servers.repository.UserCacheRepository;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class MembershipService {

    private final MembershipRepository membershipRepository;
    private final ServerRepository serverRepository;
    private final UserCacheRepository userCacheRepository;

public MembershipService(MembershipRepository membershipRepository, 
                         ServerRepository serverRepository,
                         UserCacheRepository userCacheRepository) {
    this.membershipRepository = membershipRepository;
    this.serverRepository = serverRepository;
    this.userCacheRepository = userCacheRepository;
}

    @Transactional
    public void joinServer(UUID serverId, String userId) {
        if (!serverRepository.existsById(serverId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Server not found");
        }

        // DoD: Joining an already-joined server -> HTTP 409
        if (membershipRepository.existsByServerIdAndUserId(serverId, userId)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "already a member");
        }

        Membership membership = new Membership();
        membership.setServerId(serverId);
        membership.setUserId(userId);

        membershipRepository.save(membership);
    }

    @Transactional
    public void leaveServer(UUID serverId, String userId) {
        Server server = serverRepository.findById(serverId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Server not found"));

        // DoD: Owner cannot leave
        if (server.getOwnerId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Owner cannot leave the server");
        }

        if (!membershipRepository.existsByServerIdAndUserId(serverId, userId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "You are not a member of this server");
        }

        // DoD: Removes user from memberships
        membershipRepository.deleteByServerIdAndUserId(serverId, userId);

    }
    @Transactional(readOnly = true)
 public List<Map<String, String>> getServerMembers(UUID serverId) {
     if (!serverRepository.existsById(serverId)) {
         throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Server not found");
     }

     List<Membership> memberships = membershipRepository.findByServerId(serverId);

     return memberships.stream().map(m -> {
         // Buscamos al usuario en nuestra caché local
         String username = userCacheRepository.findById(m.getUserId())
                 .map(UserCache::getUsername)
                 .orElse("Unknown_User_" + m.getUserId()); // Fallback si aún no llega el evento

         return Map.of(
                 "user_id", m.getUserId(),
                 "username", username
         );
     }).collect(Collectors.toList());
    }
}
