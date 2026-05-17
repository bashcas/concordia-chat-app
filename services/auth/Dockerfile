FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
# Copy all POMs so Maven can resolve the reactor graph
COPY pom.xml .
COPY contracts/lib/java/authmw/pom.xml contracts/lib/java/authmw/pom.xml
COPY contracts/lib/java/audit/pom.xml  contracts/lib/java/audit/pom.xml
COPY services/auth/pom.xml services/auth/pom.xml
COPY services/servers/pom.xml services/servers/pom.xml
# Source for auth and the audit library it depends on
COPY contracts/lib/java/audit/src contracts/lib/java/audit/src
COPY services/auth/src services/auth/src
# -am also builds the audit module that auth depends on
RUN mvn -pl services/auth -am package -DskipTests -q

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=build /build/services/auth/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
