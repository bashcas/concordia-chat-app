package com.concordia.audit;

/**
 * Canonical audit event_type constants, so producers cannot mistype them.
 */
public final class EventTypes {

    private EventTypes() {
    }

    // Auth service
    public static final String AUTH_REGISTER = "auth.register";
    public static final String AUTH_LOGIN_SUCCESS = "auth.login.success";
    public static final String AUTH_LOGIN_FAILURE = "auth.login.failure";
    public static final String AUTH_TOKEN_REFRESH = "auth.token.refresh";
    public static final String AUTH_LOGOUT = "auth.logout";

    // Servers service
    public static final String SERVER_CREATE = "servers.server.create";
    public static final String SERVER_UPDATE = "servers.server.update";
    public static final String SERVER_DELETE = "servers.server.delete";
    public static final String CHANNEL_CREATE = "servers.channel.create";
    public static final String CHANNEL_UPDATE = "servers.channel.update";
    public static final String CHANNEL_DELETE = "servers.channel.delete";
    public static final String ROLE_CREATE = "servers.role.create";
    public static final String ROLE_ASSIGN = "servers.role.assign";
    public static final String MEMBER_JOIN = "servers.member.join";
    public static final String MEMBER_LEAVE = "servers.member.leave";

    // Outcomes
    public static final String SUCCESS = "success";
    public static final String FAILURE = "failure";
}
