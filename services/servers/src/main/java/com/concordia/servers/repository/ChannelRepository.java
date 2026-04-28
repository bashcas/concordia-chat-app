package com.concordia.servers.repository;

import com.concordia.servers.model.Channel;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface ChannelRepository extends JpaRepository<Channel, UUID> {

    // Spring Boot automatically generates the SQL query based on the method name
    List<Channel> findByServerId(UUID serverId);
}
