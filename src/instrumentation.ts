export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.TUNNEL_DISABLED !== "true") {
    try {
      const { startTunnelServer } = await import("./tunnel/server");
      startTunnelServer();
      const { ensureDefaultNode, ensureRouteKeys } = await import("./lib/nodes");
      await ensureDefaultNode();
      await ensureRouteKeys();
      const { ensureDefaultAdmin } = await import("./lib/admin-seed");
      await ensureDefaultAdmin();
      const { ensureProbeCredential, ensureInstanceId } = await import("./lib/settings");
      await ensureProbeCredential();
      await ensureInstanceId();
      const { startNodeCheckScheduler } = await import("./lib/node-check");
      startNodeCheckScheduler();
    } catch (err) {
      console.error("[tunnel] failed to start tunnel server", err);
    }
  }
}
