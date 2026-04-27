package com.concordia.servers.service;

import com.concordia.servers.model.Membership;
import com.concordia.servers.model.Server;
import com.concordia.servers.repository.MembershipRepository;
import com.concordia.servers.repository.ServerRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Service
public class ServerService {

    private final ServerRepository serverRepository;
    private final MembershipRepository membershipRepository;

    public ServerService(ServerRepository serverRepository, MembershipRepository membershipRepository) {
        this.serverRepository = serverRepository;
        this.membershipRepository = membershipRepository;
    }

    @Transactional
    public Server createServer(String name, String ownerId) {
        // Non-blocking suggestion: Input validation
        if (name == null || name.trim().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Server name cannot be empty");
        }

        Server server = new Server();
        server.setName(name);
        server.setOwnerId(ownerId);
        Server savedServer = serverRepository.save(server);

        Membership membership = new Membership(savedServer.getId(), ownerId);
        membershipRepository.save(membership);

        return savedServer;
    }

    public List<Server> getServersByUserId(String userId) {
        List<Membership> memberships = membershipRepository.findByUserId(userId);
        List<UUID> serverIds = memberships.stream()
                .map(Membership::getServerId)
                .toList();

        return serverRepository.findAllById(serverIds);
    }

    public Optional<Server> getServerById(UUID id) {
        return serverRepository.findById(id);
    }

    @Transactional
    public Server updateServer(UUID id, String newName, String requesterId) {
        // Non-blocking suggestion: Input validation
        if (newName == null || newName.trim().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Server name cannot be empty");
        }

        Server server = serverRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Server not found"));

        if (!server.getOwnerId().equals(requesterId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Only the owner can edit this server");
        }

        server.setName(newName);
        return serverRepository.save(server);
    }

    @Transactional
    public void deleteServer(UUID id, String requesterId) {
        Server server = serverRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Server not found"));

        if (!server.getOwnerId().equals(requesterId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Only the owner can delete this server");
        }

        serverRepository.delete(server);
    }
}
