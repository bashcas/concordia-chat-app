package com.concordia.authmw;

public class Claims {
    private final String subject;
    private final String username;

    public Claims(String subject, String username) {
        this.subject = subject;
        this.username = username;
    }

    public String getSubject() {
        return subject;
    }

    public String getUsername() {
        return username;
    }

    @Override
    public String toString() {
        return "Claims{subject='" + subject + "', username='" + username + "'}";
    }
}
