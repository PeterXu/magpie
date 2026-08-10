package main

import (
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/pion/turn/v5"
)

func main() {
	// Load configuration
	cfg := DefaultConfig()
	cfg.LoadFromEnv()

	// Add default credentials if not set
	if len(cfg.Credentials) == 0 {
		cfg.Credentials["iceturn"] = "iceturn"
	}

	// Validate configuration
	if err := cfg.Validate(); err != nil {
		log.Fatalf("Invalid configuration: %v", err)
	}

	log.Printf("TURN server configuration: %s", cfg.String())

	// Create UDP listener
	udpListener, err := net.ListenPacket("udp", cfg.ListenUDP)
	if err != nil {
		log.Fatalf("Failed to create UDP listener: %w", err)
	}

	// Create TCP listener
	tcpListener, err := net.Listen("tcp", cfg.ListenTCP)
	if err != nil {
		log.Fatalf("Failed to create TCP listener: %w", err)
	}

	// Create TURN server
	// pion/turn handles all TURN protocol details:
	// - Single-port multiplexing via SO_REUSEPORT
	// - Allocation management via FiveTuple
	// - Data forwarding via XOR-PEER-ADDRESS in Data Indication
	server, err := turn.NewServer(turn.ServerConfig{
		Realm: cfg.Realm,
		AuthHandler: func(ra *turn.RequestAttributes) (string, []byte, bool) {
			password, ok := cfg.Credentials[ra.Username]
			if !ok {
				return "", nil, false
			}
			return ra.Username, turn.GenerateAuthKey(ra.Username, cfg.Realm, password), true
		},
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn: udpListener,
				RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
					RelayAddress: net.ParseIP(cfg.PublicIP),
					Address:      "0.0.0.0",
				},
			},
		},
		ListenerConfigs: []turn.ListenerConfig{
			{
				Listener: tcpListener,
				RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
					RelayAddress: net.ParseIP(cfg.PublicIP),
					Address:      "0.0.0.0",
				},
			},
		},
	})
	if err != nil {
		log.Fatalf("Failed to create TURN server: %v", err)
	}
	defer server.Close()

	log.Printf("TURN server started on %s (UDP) and %s (TCP)", cfg.ListenUDP, cfg.ListenTCP)
	log.Printf("Public IP: %s", cfg.PublicIP)
	log.Printf("Realm: %s", cfg.Realm)
	log.Printf("Credentials: %d users configured", len(cfg.Credentials))
	log.Println("Ready to accept connections...")
	log.Println("Using standard TURN protocol with single-port multiplexing")

	// Wait for interrupt signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("Shutting down TURN server...")
}