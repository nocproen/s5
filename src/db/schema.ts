import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  uuid,
  index,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    // Credential used by the proxy client (VLESS UUID)
    proxyUuid: uuid("proxy_uuid").notNull().unique().defaultRandom(),
    // Token used for the subscription URL
    subToken: text("sub_token").notNull().unique(),
    enabled: boolean("enabled").notNull().default(true),
    quotaBytes: bigint("quota_bytes", { mode: "number" })
      .notNull()
      .default(53687091200), // 50 GiB
    uploadBytes: bigint("upload_bytes", { mode: "number" }).notNull().default(0),
    downloadBytes: bigint("download_bytes", { mode: "number" })
      .notNull()
      .default(0),
    totalConnections: integer("total_connections").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("users_proxy_uuid_idx").on(t.proxyUuid)],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const nodes = pgTable("nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(443),
  path: text("path").notNull().default("/tunnel"),
  tls: boolean("tls").notNull().default(true),
  // Optional SNI / Host header override (useful behind CDN)
  sni: text("sni"),
  // "local": this deployment's own tunnel. "upstream": another server we hold a credential for.
  kind: text("kind").notNull().default("local"),
  upstreamUrl: text("upstream_url"), // wss://host[:port]/path
  upstreamUuid: text("upstream_uuid"), // credential valid on the upstream
  upstreamSni: text("upstream_sni"), // optional Host / SNI override for the upstream connection
  // upstream only: true = users connect to this site and we relay to the upstream (credential stays secret),
  // false = hand the upstream address + credential directly to users
  relay: boolean("relay").notNull().default(true),
  // path suffix that selects this node when relaying: <TUNNEL_PATH>/<routeKey>
  routeKey: text("route_key").unique(),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  // Result of the most recent health check
  lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
  lastCheckOk: boolean("last_check_ok"),
  lastCheckLatencyMs: integer("last_check_latency_ms"),
  lastCheckStage: text("last_check_stage"),
  lastCheckMessage: text("last_check_message"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const nodeChecks = pgTable(
  "node_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    ok: boolean("ok").notNull(),
    latencyMs: integer("latency_ms"),
    stage: text("stage").notNull(),
    message: text("message").notNull(),
    source: text("source").notNull().default("auto"), // "auto" | "manual"
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("node_checks_node_created_idx").on(t.nodeId, t.createdAt)],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const connectionLogs = pgTable(
  "connection_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetHost: text("target_host").notNull(),
    targetPort: integer("target_port").notNull(),
    protocol: text("protocol").notNull().default("tcp"),
    uploadBytes: bigint("upload_bytes", { mode: "number" }).notNull().default(0),
    downloadBytes: bigint("download_bytes", { mode: "number" })
      .notNull()
      .default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    clientIp: text("client_ip"),
    // name of the upstream node the connection was relayed through (null = direct)
    via: text("via"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("connection_logs_user_created_idx").on(t.userId, t.createdAt)],
);

// ---------- Backend administrators (completely separate from end users) ----------

export const admins = pgTable("admins", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // true when the account still uses the seeded default password
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const adminSessions = pgTable("admin_sessions", {
  id: text("id").primaryKey(),
  adminId: uuid("admin_id")
    .notNull()
    .references(() => admins.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Admin = typeof admins.$inferSelect;
export type User = typeof users.$inferSelect;
export type Node = typeof nodes.$inferSelect;
export type NodeCheck = typeof nodeChecks.$inferSelect;
export type ConnectionLog = typeof connectionLogs.$inferSelect;
