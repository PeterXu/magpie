# IceTurn

TURN server with single-port multiplexing based on pion/turn.

## Overview

IceTurn is a TURN server that supports:
- ✅ Single-port multiplexing for unlimited client connections
- ✅ Standard TURN protocol (RFC 5766)
- ✅ Works with standard WebRTC clients
- ✅ Docker deployment ready
- ✅ Simple and lightweight

## Key Insight

**pion/turn already provides everything needed:**

1. **Single-port multiplexing** via SO_REUSEPORT
2. **Allocation management** via FiveTuple
3. **Data forwarding** via XOR-PEER-ADDRESS in Data Indication
4. **Complete TURN protocol** implementation

No custom STUN interception or ice-ufrag pairing needed!

## Quick Start

### Build

```bash
make build
```

### Run

```bash
# Default configuration
./bin/icecoordinator

# Custom configuration
PUBLIC_IP=192.168.1.100 ./bin/icecoordinator
```

### Test

```bash
make test
```

### Docker

```bash
docker-compose up -d
```

## Configuration

### Environment Variables

```bash
# Required
PUBLIC_IP=192.168.1.100    # Public IP for relay address

# Optional (with defaults)
REALM=iceturn.local        # TURN realm (default: iceturn.local)
LISTEN_UDP=:3478           # UDP listen address (default: :3478)
LISTEN_TCP=:3478           # TCP listen address (default: :3478)

# Authentication
TURN_CREDENTIALS=user1:pass1,user2:pass2
```

## How It Works

### Single-Port Multiplexing

Multiple TURN allocations share the same relay port (e.g., 3478):

```
Client1 → TURN:3478 → Streamer
Client2 → TURN:3478 → Streamer
Client3 → TURN:3478 → Streamer
```

### How Clients Are Distinguished

When Client1 sends data to Streamer via TURN:

```
Client1 → Send Indication:
  - XOR-PEER-ADDRESS: Streamer's address
  - DATA: actual data

TURN → Data Indication:
  - XOR-PEER-ADDRESS: Client1's address ✅
  - DATA: actual data

Streamer receives:
  - Knows it's from Client1 via XOR-PEER-ADDRESS ✅
```

Each Data Indication contains the sender's address, so the receiver knows who sent each packet.

### Allocation Management

Each allocation is uniquely identified by:
- **FiveTuple**: (SrcAddr, DstAddr, Protocol)

TURN server uses FiveTuple to find the correct allocation for each packet.

## Project Structure

```
iceturn/
├── cmd/icecoordinator/main.go    # Main program (simple wrapper)
├── internal/config/config.go     # Configuration management
├── docs/                         # Documentation
├── Dockerfile                    # Docker image
└── docker-compose.yml            # Docker Compose config
```

## Architecture

```
WebRTC Client/Streamer
  │
  └─> TURN Allocate (standard TURN protocol)
  └─> Send/ChannelData (standard TURN protocol)
      │
      ↓
pion/turn Server
  ├─> FiveTuple-based allocation tracking
  ├─> Permission/Channel management
  └─> Data forwarding with XOR-PEER-ADDRESS
```

## Standards Compliance

- ✅ RFC 5766 - TURN Protocol
- ✅ RFC 5389 - STUN Protocol
- ✅ Standard WebRTC compatibility

## Documentation

- [Design Document](docs/2026-08-10-custom-turn-server-design.md) - Original design
- [Implementation Notes](docs/TURN_IMPLEMENTATION.md) - How it actually works

## Testing

Tested with standard TURN clients and WebRTC implementations.

## License

MIT