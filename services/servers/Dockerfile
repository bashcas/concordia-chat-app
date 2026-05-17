FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build

COPY pom.xml .
COPY contracts/lib/java/authmw/pom.xml contracts/lib/java/authmw/pom.xml
COPY contracts/lib/java/audit/pom.xml  contracts/lib/java/audit/pom.xml
COPY services/auth/pom.xml services/auth/pom.xml
COPY services/servers/pom.xml services/servers/pom.xml

COPY contracts/proto contracts/proto
COPY contracts/lib/java/audit/src contracts/lib/java/audit/src
COPY services/servers/src services/servers/src
# -am also builds the audit module that servers depends on
RUN mvn -pl services/servers -am package -DskipTests

FROM eclipse-temurin:21-jre-alpine
COPY --from=build /build/services/servers/target/*.jar app.jar
ENTRYPOINT ["java", "-jar", "app.jar"]
