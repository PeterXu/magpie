# Build stage
FROM golang:1.26.1-alpine AS builder

WORKDIR /build

# Install dependencies
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories
RUN apk add --no-cache git

# Copy go mod files
ENV GOPROXY=https://proxy.golang.org,https://mirrors.aliyun.com/goproxy/,https://goproxy.cn,direct
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY cmd ./cmd
COPY config.yaml .

# Build binary
RUN CGO_ENABLED=0 GOOS= GOARCH= go build -ldflags="-w -s" -o icecoordinator ./cmd/icecoordinator

# Runtime stage
FROM alpine:3

WORKDIR /app

# Install ca-certificates, tzdata, and netcat for healthcheck
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories
RUN apk --no-cache add ca-certificates tzdata netcat-openbsd

# Copy binary from builder
COPY --from=builder /build/icecoordinator .
COPY --from=builder /build/config.yaml .

# Create log directory
RUN mkdir -p /var/log/iceturn

# Expose ports
EXPOSE 3478/udp
EXPOSE 3478/tcp

# Health check - verify both TCP and UDP ports are listening
# nc -z checks TCP, nc -zu checks UDP (with timeout to avoid hanging)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD nc -z localhost 3478 && nc -zu -w1 localhost 3478 || exit 1

# Run
ENTRYPOINT ["./icecoordinator"]
