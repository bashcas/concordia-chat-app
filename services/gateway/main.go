package main

import (
	"log"
	"net/http"
	"os"
	_ "net/http/pprof" // registers /debug/pprof handlers on http.DefaultServeMux
)

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	port := getenv("GATEWAY_PORT", "8080")
	log.Printf("gateway starting on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, buildMux(configFromEnv())))
}
