package main

import (
	"fmt"
	"net"
	"os"
	"strings"
)

// Config represents the TURN server configuration
type Config struct {
	// Realm for TURN authentication
	Realm string

	// Listener addresses
	ListenUDP string
	ListenTCP string

	// Public IP for relay address
	PublicIP string

	// Authentication credentials
	Credentials map[string]string // username -> password
}

// DefaultConfig returns a default configuration
func DefaultConfig() *Config {
	return &Config{
		Realm:       "iceturn.local",
		ListenUDP:   ":3478",
		ListenTCP:   ":3478",
		PublicIP:    "127.0.0.1",
		Credentials: make(map[string]string),
	}
}

// LoadFromEnv loads configuration from environment variables
func (c *Config) LoadFromEnv() {
	if realm := os.Getenv("REALM"); realm != "" {
		c.Realm = realm
	}

	if publicIP := os.Getenv("PUBLIC_IP"); publicIP != "" {
		c.PublicIP = publicIP
	}

	if listenUDP := os.Getenv("LISTEN_UDP"); listenUDP != "" {
		c.ListenUDP = listenUDP
	}

	if listenTCP := os.Getenv("LISTEN_TCP"); listenTCP != "" {
		c.ListenTCP = listenTCP
	}

	// Load credentials from environment
	// Format: TURN_CREDENTIALS=user1:pass1,user2:pass2
	if users := os.Getenv("TURN_CREDENTIALS"); users != "" {
		c.parseCredentials(users)
	}
}

// parseCredentials parses credentials from format: user1:pass1,user2:pass2
func (c *Config) parseCredentials(creds string) {
	pairs := strings.Split(creds, ",")
	for _, pair := range pairs {
		parts := strings.Split(pair, ":")
		if len(parts) == 2 {
			c.Credentials[parts[0]] = parts[1]
		}
	}
}

// Validate validates the configuration
func (c *Config) Validate() error {
	if c.Realm == "" {
		return fmt.Errorf("realm cannot be empty")
	}

	if c.PublicIP == "" {
		return fmt.Errorf("public_ip cannot be empty")
	}

	if net.ParseIP(c.PublicIP) == nil {
		return fmt.Errorf("invalid public_ip: %s", c.PublicIP)
	}

	return nil
}

// String returns a string representation of the config
func (c *Config) String() string {
	return fmt.Sprintf("Config{Realm=%s, PublicIP=%s, ListenUDP=%s, ListenTCP=%s, Credentials=%d}",
		c.Realm, c.PublicIP, c.ListenUDP, c.ListenTCP, len(c.Credentials))
}