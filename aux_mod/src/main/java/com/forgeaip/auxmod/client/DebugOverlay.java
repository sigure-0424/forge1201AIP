package com.forgeaip.auxmod.client;

import com.forgeaip.auxmod.AuxMod;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.*;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.GameRenderer;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.RenderLevelStageEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.event.lifecycle.FMLClientSetupEvent;
import org.joml.Matrix4f;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * VDS-001: DebugOverlay — renders bot path, stuck marker, and mismatch blocks
 * in the Minecraft world using data received from the Node.js debug WebSocket
 * server on ws://localhost:3001.
 *
 * Toggle rendering with F8 (shares the existing HUD_TOGGLE_KEY binding).
 *
 * Thread safety:
 *  - Path / mismatch data stored in CopyOnWriteArrayList.
 *  - Stuck position and bot position stored as volatile references.
 */
@Mod.EventBusSubscriber(modid = AuxMod.MOD_ID, value = Dist.CLIENT)
public class DebugOverlay {

    // ── Toggle ────────────────────────────────────────────────────────────────
    private static volatile boolean overlayEnabled = true;

    public static void toggleOverlay() {
        overlayEnabled = !overlayEnabled;
        AuxMod.LOGGER.info("[DebugOverlay] Overlay {}", overlayEnabled ? "enabled" : "disabled");
    }

    public static boolean isOverlayEnabled() { return overlayEnabled; }

    // ── Data updated from WS thread ───────────────────────────────────────────
    /** Path waypoints [[x,y,z], ...] */
    private static final CopyOnWriteArrayList<double[]> pathPoints = new CopyOnWriteArrayList<>();
    /** Mismatch block positions [[x,y,z], ...] */
    private static final CopyOnWriteArrayList<double[]> mismatchBlocks = new CopyOnWriteArrayList<>();
    /** Volatile: stuck position [x,y,z] or null. */
    private static volatile double[] stuckPos = null;
    private static volatile long stuckExpiry = 0; // epoch ms
    /** Volatile: bot position [x,y,z] for label. */
    private static volatile double[] botPos = null;

    // ── WebSocket (java.net.http — built into JDK 11+, no external dependency) ──
    private static final HttpClient httpClient = HttpClient.newHttpClient();
    private static WebSocket wsClient = null;
    private static final ScheduledExecutorService scheduler =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "DebugOverlay-WS");
                t.setDaemon(true);
                return t;
            });

    /**
     * Called from {@link AuxMod#clientSetup(FMLClientSetupEvent)} to start the
     * WebSocket connection attempt.
     */
    public static void init() {
        scheduleConnect();
        AuxMod.LOGGER.info("[DebugOverlay] Initialized, connecting to ws://localhost:3001");
    }

    private static void scheduleConnect() {
        scheduler.schedule(DebugOverlay::connect, 0, TimeUnit.SECONDS);
    }

    private static void connect() {
        try {
            httpClient.newWebSocketBuilder()
                    .connectTimeout(java.time.Duration.ofSeconds(5))
                    .buildAsync(URI.create("ws://localhost:3001"), new WsListener())
                    .whenComplete((ws, ex) -> {
                        if (ex != null) {
                            AuxMod.LOGGER.debug("[DebugOverlay] WS connect failed: {}", ex.getMessage());
                            scheduler.schedule(DebugOverlay::connect, 5, TimeUnit.SECONDS);
                        } else {
                            wsClient = ws;
                            AuxMod.LOGGER.info("[DebugOverlay] Connected to debug WS server.");
                        }
                    });
        } catch (Exception e) {
            AuxMod.LOGGER.debug("[DebugOverlay] WS connect error: {}", e.getMessage());
            scheduler.schedule(DebugOverlay::connect, 5, TimeUnit.SECONDS);
        }
    }

    // ── WebSocket listener ────────────────────────────────────────────────────
    private static class WsListener implements WebSocket.Listener {
        private final StringBuilder textAccumulator = new StringBuilder();

        @Override
        public void onOpen(WebSocket ws) {
            ws.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            textAccumulator.append(data);
            if (last) {
                String message = textAccumulator.toString();
                textAccumulator.setLength(0);
                try { handleMessage(message); } catch (Exception e) {
                    AuxMod.LOGGER.debug("[DebugOverlay] Message parse error: {}", e.getMessage());
                }
            }
            ws.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
            AuxMod.LOGGER.debug("[DebugOverlay] WS closed: {}", reason);
            scheduler.schedule(DebugOverlay::connect, 5, TimeUnit.SECONDS);
            return null;
        }

        @Override
        public void onError(WebSocket ws, Throwable error) {
            AuxMod.LOGGER.debug("[DebugOverlay] WS error: {}", error.getMessage());
            scheduler.schedule(DebugOverlay::connect, 5, TimeUnit.SECONDS);
        }
    }

    // ── Minimal JSON parser (no Gson needed) ──────────────────────────────────
    private static void handleMessage(String text) {
        // Extract "type" field
        String type = extractString(text, "type");
        if (type == null) return;

        switch (type) {
            case "path": {
                // data.points: [[x,y,z], ...]
                List<double[]> pts = parseDoubleArrays(text, "points");
                pathPoints.clear();
                pathPoints.addAll(pts);
                break;
            }
            case "stuck": {
                // data.pos: [x,y,z], data.duration_sec
                double[] pos = parseFirstDoubleArray(text, "pos");
                stuckPos = pos;
                stuckExpiry = System.currentTimeMillis() + 10_000L;
                break;
            }
            case "mismatch": {
                // data.blocks: [[x,y,z,stateId,name], ...]
                List<double[]> blocks = parseDoubleArrays(text, "blocks");
                mismatchBlocks.clear();
                mismatchBlocks.addAll(blocks);
                break;
            }
            case "status": {
                // data.pos: [x,y,z]
                double[] pos = parseFirstDoubleArray(text, "pos");
                if (pos != null) botPos = pos;
                break;
            }
        }
    }

    /** Very small helper: find the first quoted string value for a key. */
    private static String extractString(String json, String key) {
        String search = "\"" + key + "\"";
        int ki = json.indexOf(search);
        if (ki < 0) return null;
        int colon = json.indexOf(':', ki + search.length());
        if (colon < 0) return null;
        int q1 = json.indexOf('"', colon + 1);
        if (q1 < 0) return null;
        int q2 = json.indexOf('"', q1 + 1);
        if (q2 < 0) return null;
        return json.substring(q1 + 1, q2);
    }

    /** Parse [[n,n,n], [n,n,n], ...] arrays from JSON; returns up to 3 numbers per entry. */
    private static List<double[]> parseDoubleArrays(String json, String key) {
        List<double[]> result = new ArrayList<>();
        String search = "\"" + key + "\"";
        int ki = json.indexOf(search);
        if (ki < 0) return result;
        int bracket = json.indexOf('[', ki + search.length() + 1);
        if (bracket < 0) return result;
        int end = json.lastIndexOf(']');
        if (end <= bracket) return result;
        String inner = json.substring(bracket + 1, end);
        // Each sub-array like [x,y,z] or [x,y,z,s,"name"]
        int pos = 0;
        while (pos < inner.length()) {
            int open = inner.indexOf('[', pos);
            if (open < 0) break;
            int close = inner.indexOf(']', open);
            if (close < 0) break;
            String nums = inner.substring(open + 1, close);
            String[] parts = nums.split(",");
            double[] arr = new double[Math.min(3, parts.length)];
            for (int i = 0; i < arr.length; i++) {
                try { arr[i] = Double.parseDouble(parts[i].trim()); } catch (NumberFormatException e2) { arr[i] = 0; }
            }
            result.add(arr);
            pos = close + 1;
        }
        return result;
    }

    private static double[] parseFirstDoubleArray(String json, String key) {
        List<double[]> arrays = parseDoubleArrays(json, key);
        return arrays.isEmpty() ? null : arrays.get(0);
    }

    // ── Render ────────────────────────────────────────────────────────────────
    @SubscribeEvent
    public static void onRenderLevelLast(RenderLevelStageEvent event) {
        if (event.getStage() != RenderLevelStageEvent.Stage.AFTER_TRANSLUCENT_BLOCKS) return;
        if (!overlayEnabled) return;

        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.level == null) return;

        Matrix4f poseMatrix = event.getPoseStack().last().pose();

        // Camera offset
        double camX = mc.gameRenderer.getMainCamera().getPosition().x;
        double camY = mc.gameRenderer.getMainCamera().getPosition().y;
        double camZ = mc.gameRenderer.getMainCamera().getPosition().z;

        RenderSystem.enableBlend();
        RenderSystem.defaultBlendFunc();
        RenderSystem.disableDepthTest();
        RenderSystem.setShader(GameRenderer::getPositionColorShader);

        BufferBuilder buf = Tesselator.getInstance().getBuilder();

        // ── Draw path (yellow lines) ──────────────────────────────────────────
        List<double[]> pts = new ArrayList<>(pathPoints);
        if (pts.size() > 1) {
            buf.begin(VertexFormat.Mode.DEBUG_LINE_STRIP, DefaultVertexFormat.POSITION_COLOR);
            for (double[] p : pts) {
                buf.vertex(poseMatrix, (float)(p[0] - camX), (float)(p[1] - camY + 0.05), (float)(p[2] - camZ))
                   .color(1.0f, 0.95f, 0.0f, 0.85f).endVertex();
            }
            Tesselator.getInstance().end();
        }

        // ── Draw mismatch block wireframes (red) ──────────────────────────────
        List<double[]> mismatches = new ArrayList<>(mismatchBlocks);
        for (double[] b : mismatches) {
            drawWireframeCube(buf, poseMatrix, b[0] - camX, b[1] - camY, b[2] - camZ,
                    1.0f, 0.0f, 0.0f, 0.7f);
        }

        // ── Draw stuck marker (red cube at stuck pos) ─────────────────────────
        if (stuckPos != null && System.currentTimeMillis() < stuckExpiry) {
            double[] sp = stuckPos;
            drawFilledCube(buf, poseMatrix,
                    sp[0] - camX + 0.35, sp[1] - camY + 0.35, sp[2] - camZ + 0.35,
                    0.3f, 1.0f, 0.0f, 0.0f, 0.7f);
        }

        RenderSystem.enableDepthTest();
        RenderSystem.disableBlend();
    }

    private static void drawWireframeCube(BufferBuilder buf, Matrix4f m,
                                           double ox, double oy, double oz,
                                           float r, float g, float b, float a) {
        float x0 = (float) ox,  y0 = (float) oy,  z0 = (float) oz;
        float x1 = x0 + 1f,    y1 = y0 + 1f,    z1 = z0 + 1f;
        buf.begin(VertexFormat.Mode.DEBUG_LINES, DefaultVertexFormat.POSITION_COLOR);
        // Bottom face
        line(buf, m, x0,y0,z0, x1,y0,z0, r,g,b,a);
        line(buf, m, x1,y0,z0, x1,y0,z1, r,g,b,a);
        line(buf, m, x1,y0,z1, x0,y0,z1, r,g,b,a);
        line(buf, m, x0,y0,z1, x0,y0,z0, r,g,b,a);
        // Top face
        line(buf, m, x0,y1,z0, x1,y1,z0, r,g,b,a);
        line(buf, m, x1,y1,z0, x1,y1,z1, r,g,b,a);
        line(buf, m, x1,y1,z1, x0,y1,z1, r,g,b,a);
        line(buf, m, x0,y1,z1, x0,y1,z0, r,g,b,a);
        // Verticals
        line(buf, m, x0,y0,z0, x0,y1,z0, r,g,b,a);
        line(buf, m, x1,y0,z0, x1,y1,z0, r,g,b,a);
        line(buf, m, x1,y0,z1, x1,y1,z1, r,g,b,a);
        line(buf, m, x0,y0,z1, x0,y1,z1, r,g,b,a);
        Tesselator.getInstance().end();
    }

    private static void drawFilledCube(BufferBuilder buf, Matrix4f m,
                                        double ox, double oy, double oz,
                                        float size, float r, float g, float b, float a) {
        float x0 = (float) ox,       y0 = (float) oy,       z0 = (float) oz;
        float x1 = x0 + size,        y1 = y0 + size,        z1 = z0 + size;
        buf.begin(VertexFormat.Mode.QUADS, DefaultVertexFormat.POSITION_COLOR);
        // -Y
        buf.vertex(m,x0,y0,z0).color(r,g,b,a).endVertex();
        buf.vertex(m,x1,y0,z0).color(r,g,b,a).endVertex();
        buf.vertex(m,x1,y0,z1).color(r,g,b,a).endVertex();
        buf.vertex(m,x0,y0,z1).color(r,g,b,a).endVertex();
        // +Y
        buf.vertex(m,x0,y1,z0).color(r,g,b,a).endVertex();
        buf.vertex(m,x0,y1,z1).color(r,g,b,a).endVertex();
        buf.vertex(m,x1,y1,z1).color(r,g,b,a).endVertex();
        buf.vertex(m,x1,y1,z0).color(r,g,b,a).endVertex();
        // -Z
        buf.vertex(m,x0,y0,z0).color(r,g,b,a).endVertex();
        buf.vertex(m,x0,y1,z0).color(r,g,b,a).endVertex();
        buf.vertex(m,x1,y1,z0).color(r,g,b,a).endVertex();
        buf.vertex(m,x1,y0,z0).color(r,g,b,a).endVertex();
        // +Z
        buf.vertex(m,x0,y0,z1).color(r,g,b,a).endVertex();
        buf.vertex(m,x1,y0,z1).color(r,g,b,a).endVertex();
        buf.vertex(m,x1,y1,z1).color(r,g,b,a).endVertex();
        buf.vertex(m,x0,y1,z1).color(r,g,b,a).endVertex();
        // -X
        buf.vertex(m,x0,y0,z0).color(r,g,b,a).endVertex();
        buf.vertex(m,x0,y0,z1).color(r,g,b,a).endVertex();
        buf.vertex(m,x0,y1,z1).color(r,g,b,a).endVertex();
        buf.vertex(m,x0,y1,z0).color(r,g,b,a).endVertex();
        // +X
        buf.vertex(m,x1,y0,z0).color(r,g,b,a).endVertex();
        buf.vertex(m,x1,y1,z0).color(r,g,b,a).endVertex();
        buf.vertex(m,x1,y1,z1).color(r,g,b,a).endVertex();
        buf.vertex(m,x1,y0,z1).color(r,g,b,a).endVertex();
        Tesselator.getInstance().end();
    }

    private static void line(BufferBuilder buf, Matrix4f m,
                               float x0, float y0, float z0,
                               float x1, float y1, float z1,
                               float r, float g, float b, float a) {
        buf.vertex(m, x0, y0, z0).color(r, g, b, a).endVertex();
        buf.vertex(m, x1, y1, z1).color(r, g, b, a).endVertex();
    }
}
