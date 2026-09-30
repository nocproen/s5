// S5 Tunnel 轻量客户端 (Go) —— 本地 SOCKS5 ⇄ WebSocket ⇄ 服务器
// S5 Tunnel lightweight client (Go) — local SOCKS5 ⇄ WebSocket ⇄ server
//
// 仅使用标准库，Go 1.18+。可直接运行，也可编译成单个静态二进制文件分发到任何平台。
// Standard library only, Go 1.18+. Run directly or build one static binary for any OS.
//
//	go run socks5-ws-client.go --server wss://example.com/tunnel --uuid <UUID> --listen 127.0.0.1:1080
//	go build -o s5client socks5-ws-client.go
//	GOOS=windows GOARCH=amd64 go build -o s5client.exe socks5-ws-client.go
//	GOOS=darwin  GOARCH=arm64 go build -o s5client-mac socks5-ws-client.go
//
// 协议：VLESS over WebSocket（与 v2rayN / v2rayNG / Shadowrocket / Clash Meta 等客户端兼容）。
package main

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	mrand "math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	defaultServer = "__SERVER__"
	defaultUUID   = "__UUID__"
	defaultListen = "127.0.0.1:1080"
)

var (
	flagServer   string
	flagUUID     string
	flagListen   string
	flagInsecure bool
	flagVerbose  bool
	uuidBytes    []byte
	active       int64
	totalUp      int64
	totalDown    int64
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func logf(format string, a ...interface{}) {
	if flagVerbose {
		log.Printf(format, a...)
	}
}

// ---------- WebSocket (RFC 6455, client side) ----------

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type wsConn struct {
	c   net.Conn
	r   *bufio.Reader
	wmu sync.Mutex
}

func wsDial(rawURL string, insecure bool) (*wsConn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	useTLS := u.Scheme == "wss"
	if u.Scheme != "ws" && !useTLS {
		return nil, errors.New("server 必须是 ws:// 或 wss:// 地址")
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		if useTLS {
			port = "443"
		} else {
			port = "80"
		}
	}
	addr := net.JoinHostPort(host, port)
	d := net.Dialer{Timeout: 15 * time.Second}
	var c net.Conn
	if useTLS {
		c, err = tls.DialWithDialer(&d, "tcp", addr, &tls.Config{ServerName: host, InsecureSkipVerify: insecure}) //nolint:gosec
	} else {
		c, err = d.Dial("tcp", addr)
	}
	if err != nil {
		return nil, err
	}
	keyRaw := make([]byte, 16)
	if _, err := rand.Read(keyRaw); err != nil {
		c.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyRaw)
	path := u.RequestURI()
	if path == "" {
		path = "/"
	}
	hostHeader := host
	if (useTLS && port != "443") || (!useTLS && port != "80") {
		hostHeader = addr
	} else if strings.Contains(host, ":") {
		hostHeader = "[" + host + "]"
	}
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: s5-tunnel-go/1.0\r\n\r\n", path, hostHeader, key)
	_ = c.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := io.WriteString(c, req); err != nil {
		c.Close()
		return nil, err
	}
	br := bufio.NewReaderSize(c, 64*1024)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		c.Close()
		return nil, fmt.Errorf("握手失败: %w", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		c.Close()
		return nil, fmt.Errorf("握手失败: %s", resp.Status)
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	if resp.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		c.Close()
		return nil, errors.New("握手失败: Sec-WebSocket-Accept 校验不通过")
	}
	_ = c.SetDeadline(time.Time{})
	return &wsConn{c: c, r: br}, nil
}

func (w *wsConn) writeFrame(opcode byte, payload []byte) error {
	w.wmu.Lock()
	defer w.wmu.Unlock()
	var hdr [14]byte
	hdr[0] = 0x80 | opcode
	n := len(payload)
	i := 2
	switch {
	case n < 126:
		hdr[1] = 0x80 | byte(n)
	case n < 65536:
		hdr[1] = 0x80 | 126
		binary.BigEndian.PutUint16(hdr[2:], uint16(n))
		i = 4
	default:
		hdr[1] = 0x80 | 127
		binary.BigEndian.PutUint64(hdr[2:], uint64(n))
		i = 10
	}
	mask := hdr[i : i+4]
	binary.LittleEndian.PutUint32(mask, mrand.Uint32())
	i += 4
	masked := make([]byte, n)
	for j := range payload {
		masked[j] = payload[j] ^ mask[j&3]
	}
	bufs := net.Buffers{hdr[:i], masked}
	_, err := bufs.WriteTo(w.c)
	return err
}

// readMessage returns the next frame's opcode and payload (masking removed).
func (w *wsConn) readMessage() (byte, []byte, error) {
	var h [2]byte
	if _, err := io.ReadFull(w.r, h[:]); err != nil {
		return 0, nil, err
	}
	opcode := h[0] & 0x0f
	masked := h[1]&0x80 != 0
	n := uint64(h[1] & 0x7f)
	switch n {
	case 126:
		var b [2]byte
		if _, err := io.ReadFull(w.r, b[:]); err != nil {
			return 0, nil, err
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err := io.ReadFull(w.r, b[:]); err != nil {
			return 0, nil, err
		}
		n = binary.BigEndian.Uint64(b[:])
	}
	if n > 64<<20 {
		return 0, nil, errors.New("frame too large")
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(w.r, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(w.r, p); err != nil {
		return 0, nil, err
	}
	if masked {
		for j := range p {
			p[j] ^= mask[j&3]
		}
	}
	return opcode, p, nil
}

func (w *wsConn) close(code uint16) {
	var b [2]byte
	binary.BigEndian.PutUint16(b[:], code)
	_ = w.c.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_ = w.writeFrame(0x8, b[:])
	_ = w.c.Close()
}

// ---------- VLESS ----------

func vlessHeader(host string, port uint16) []byte {
	b := make([]byte, 0, 64)
	b = append(b, 0)            // version
	b = append(b, uuidBytes...) // uuid
	b = append(b, 0)            // addons length
	b = append(b, 1)            // cmd: TCP
	b = append(b, byte(port>>8), byte(port))
	if ip := net.ParseIP(host); ip != nil {
		if ip4 := ip.To4(); ip4 != nil {
			b = append(b, 1)
			b = append(b, ip4...)
		} else {
			b = append(b, 3)
			b = append(b, ip.To16()...)
		}
	} else {
		b = append(b, 2, byte(len(host)))
		b = append(b, host...)
	}
	return b
}

// ---------- SOCKS5 ----------

var socksOK = []byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}

func socksFail(code byte) []byte { return []byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0} }

func handle(conn net.Conn) {
	defer conn.Close()
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	br := bufio.NewReader(conn)
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	var hdr [2]byte
	if _, err := io.ReadFull(br, hdr[:]); err != nil || hdr[0] != 5 {
		return
	}
	if _, err := io.CopyN(io.Discard, br, int64(hdr[1])); err != nil {
		return
	}
	if _, err := conn.Write([]byte{5, 0}); err != nil { // NO AUTH
		return
	}
	var req [4]byte
	if _, err := io.ReadFull(br, req[:]); err != nil || req[0] != 5 {
		return
	}
	var host string
	switch req[3] {
	case 1:
		var b [4]byte
		if _, err := io.ReadFull(br, b[:]); err != nil {
			return
		}
		host = net.IP(b[:]).String()
	case 3:
		l, err := br.ReadByte()
		if err != nil {
			return
		}
		b := make([]byte, l)
		if _, err := io.ReadFull(br, b); err != nil {
			return
		}
		host = string(b)
	case 4:
		var b [16]byte
		if _, err := io.ReadFull(br, b[:]); err != nil {
			return
		}
		host = net.IP(b[:]).String()
	default:
		_, _ = conn.Write(socksFail(8))
		return
	}
	var pb [2]byte
	if _, err := io.ReadFull(br, pb[:]); err != nil {
		return
	}
	port := binary.BigEndian.Uint16(pb[:])
	if req[1] != 1 { // only CONNECT
		_, _ = conn.Write(socksFail(7))
		return
	}
	_ = conn.SetReadDeadline(time.Time{})

	n := atomic.AddInt64(&active, 1)
	defer atomic.AddInt64(&active, -1)
	logf("→ %s:%d (active %d)", host, port, n)

	ws, err := wsDial(flagServer, flagInsecure)
	if err != nil {
		log.Printf("连接服务器失败: %v", err)
		_, _ = conn.Write(socksFail(5))
		return
	}
	defer ws.c.Close()
	if err := ws.writeFrame(0x2, vlessHeader(host, port)); err != nil {
		_, _ = conn.Write(socksFail(1))
		return
	}
	if _, err := conn.Write(socksOK); err != nil {
		return
	}

	done := make(chan struct{}, 2)
	go func() { // SOCKS -> WebSocket
		buf := make([]byte, 32*1024)
		for {
			m, err := br.Read(buf)
			if m > 0 {
				atomic.AddInt64(&totalUp, int64(m))
				if werr := ws.writeFrame(0x2, buf[:m]); werr != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		done <- struct{}{}
	}()
	go func() { // WebSocket -> SOCKS
		headerDone := false
		var pending []byte
		for {
			op, p, err := ws.readMessage()
			if err != nil {
				break
			}
			switch op {
			case 0x8:
				code := uint16(1005)
				if len(p) >= 2 {
					code = binary.BigEndian.Uint16(p)
				}
				if code == 1008 {
					log.Printf("服务器拒绝连接: %s（请检查 UUID / 流量 / 有效期）", string(p[2:]))
				}
				logf("← %s:%d closed (%d)", host, port, code)
				done <- struct{}{}
				return
			case 0x9:
				_ = ws.writeFrame(0xA, p)
				continue
			case 0xA:
				continue
			}
			if !headerDone {
				pending = append(pending, p...)
				if len(pending) < 2 {
					continue
				}
				al := int(pending[1])
				if len(pending) < 2+al {
					continue
				}
				p = pending[2+al:]
				headerDone = true
				pending = nil
				if len(p) == 0 {
					continue
				}
			}
			atomic.AddInt64(&totalDown, int64(len(p)))
			if _, err := conn.Write(p); err != nil {
				break
			}
		}
		done <- struct{}{}
	}()
	<-done
	ws.close(1000)
	_ = conn.Close()
}

func main() {
	flag.StringVar(&flagServer, "server", envOr("S5_SERVER", defaultServer), "wss://host/path")
	flag.StringVar(&flagUUID, "uuid", envOr("S5_UUID", defaultUUID), "user UUID")
	flag.StringVar(&flagListen, "listen", envOr("S5_LISTEN", defaultListen), "local SOCKS5 listen address")
	flag.BoolVar(&flagInsecure, "insecure", false, "skip TLS certificate verification")
	flag.BoolVar(&flagVerbose, "v", false, "verbose logging")
	flag.Parse()
	log.SetFlags(log.Ltime)

	if flagServer == "" || strings.HasPrefix(flagServer, "__") || flagUUID == "" || strings.HasPrefix(flagUUID, "__") {
		fmt.Fprintln(os.Stderr, "用法: go run socks5-ws-client.go --server wss://host/tunnel --uuid <UUID> [--listen 127.0.0.1:1080]")
		os.Exit(1)
	}
	if !regexp.MustCompile(`^[0-9a-fA-F-]{36}$`).MatchString(flagUUID) {
		fmt.Fprintln(os.Stderr, "UUID 格式不正确")
		os.Exit(1)
	}
	var err error
	uuidBytes, err = hex.DecodeString(strings.ReplaceAll(flagUUID, "-", ""))
	if err != nil || len(uuidBytes) != 16 {
		fmt.Fprintln(os.Stderr, "UUID 格式不正确")
		os.Exit(1)
	}
	mrand.Seed(time.Now().UnixNano())

	ln, err := net.Listen("tcp", flagListen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "监听失败:", err)
		os.Exit(1)
	}
	fmt.Printf("✔ SOCKS5 代理已启动: socks5://%s\n", flagListen)
	fmt.Printf("  服务器: %s\n", flagServer)
	fmt.Printf("  UUID  : %s…\n", flagUUID[:8])
	fmt.Printf("  把浏览器/系统代理设置为 SOCKS5 %s 即可使用，Ctrl+C 退出\n", flagListen)

	if flagVerbose {
		go func() {
			for range time.Tick(10 * time.Second) {
				log.Printf("[stats] active=%d up=%.2fMB down=%.2fMB", atomic.LoadInt64(&active),
					float64(atomic.LoadInt64(&totalUp))/1048576, float64(atomic.LoadInt64(&totalDown))/1048576)
			}
		}()
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		go handle(c)
	}
}
