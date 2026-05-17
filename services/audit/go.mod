module concordia/auditsvc

go 1.24.0

// concordia/audit is resolved via the Go workspace (go.work), like the other
// concordia/* modules — it has no network-fetchable version.
require (
	github.com/golang-jwt/jwt/v5 v5.2.2
	github.com/lib/pq v1.10.9
	github.com/segmentio/kafka-go v0.4.47
)

require (
	github.com/klauspost/compress v1.15.9 // indirect
	github.com/pierrec/lz4/v4 v4.1.15 // indirect
	golang.org/x/net v0.49.0 // indirect
)
