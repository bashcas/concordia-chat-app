package com.concordia.servers.service;

import com.concordia.servers.model.Permission;
import com.concordia.servers.model.Role;
import com.concordia.servers.model.Server;
import com.concordia.servers.repository.RoleRepository;
import com.concordia.servers.repository.ServerRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.Set;
import java.util.UUID;

@Service
public class RoleService {

    private final RoleRepository roleRepository;
    private final ServerRepository serverRepository;

    public RoleService(RoleRepository roleRepository, ServerRepository serverRepository) {
        this.roleRepository = roleRepository;
        this.serverRepository = serverRepository;
    }

    @Transactional
    public Role createRole(UUID serverId, String name, Set<Permission> permissions) {
        if (!serverRepository.existsById(serverId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Server not found");
        }

        Role role = new Role();
        role.setId(UUID.randomUUID());
        role.setServerId(serverId);
        role.setName(name);
        role.setPermissions(permissions);

        return roleRepository.save(role);
    }

    @Transactional
    public void assignRole(UUID serverId, String targetUserId, UUID roleId, String requesterId) {
        Server server = serverRepository.findById(serverId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Server not found"));

        // DoD: requires MANAGE permission (or be the owner)
        boolean isOwner = server.getOwnerId().equals(requesterId);
        boolean hasManagePermission = isOwner || roleRepository.findRolesByUserAndServer(serverId, requesterId)
                .stream()
                .flatMap(r -> r.getPermissions().stream())
                .anyMatch(p -> p == Permission.MANAGE);

        if (!hasManagePermission) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "You need MANAGE permissions to assign roles");
        }

        roleRepository.assignRoleToMember(serverId, targetUserId, roleId);
    }
}
