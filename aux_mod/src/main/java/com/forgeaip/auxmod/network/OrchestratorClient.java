package com.forgeaip.auxmod.network;

import com.forgeaip.auxmod.AuxMod;
import com.forgeaip.auxmod.ForgeAIPConfig;
import com.forgeaip.auxmod.data.BotStatus;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

/**
 * Singleton HTTP + WebSocket client for the orchestrator (Node.js bot system).
 *
 * <p>All network calls run on a shared background executor. The WebSocket
 * listener automatically schedules a reconnect after 5 seconds on close/error.
 */
public class OrchestratorClient {

    // -------------------------------------------------------------------------
    // Singleton
    // -------------------------------------------------------------------------

    private static OrchestratorClient INSTANCE;

    public static synchronized OrchestratorClient getInstance() {
        if (INSTANCE == null) {
            INSTANCE = new OrchestratorClient();
        }
        return INSTANCE;
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /** Live bot statuses keyed by botId, updated from WebSocket messages. */
    public final Map<String, BotStatus> botStatuses = new ConcurrentHashMap<>();

    private final HttpClient httpClient;
    private final ScheduledExecutorService scheduler;
    private WebSocket webSocket;
    private volatile boolean connected = false;
    private volatile boolean intentionalClose = false;

    /** Listeners notified when any WebSocket message arrives. The String argument is the raw JSON. */
    private final List<Consumer<String>> messageListeners = new CopyOnWriteArrayList<>();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    private OrchestratorClient() {
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .build();
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "ForgeAIP-Orchestrator");
            t.setDaemon(true);
            return t;
        });
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /** Add a listener that receives raw JSON strings from WebSocket messages. */
    public void addMessageListener(Consumer<String> listener) {
        messageListeners.add(listener);
    }

    public void removeMessageListener(Consumer<String> listener) {
        messageListeners.remove(listener);
    }

    /** Returns true if the WebSocket is currently connected. */
    public boolean isConnected() {
        return connected;
    }

    /**
     * Initiates a WebSocket connection to the orchestrator.
     * Safe to call multiple times; if already connected, does nothing.
     */
    public void connect() {
        if (connected) return;
        intentionalClose = false;
        String wsUrl = ForgeAIPConfig.getWebSocketUrl();
        AuxMod.LOGGER.info("[ForgeAIP] Connecting WebSocket to {}", wsUrl);
        httpClient.newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .buildAsync(URI.create(wsUrl), new WsListener())
                .whenComplete((ws, ex) -> {
                    if (ex != null) {
                        AuxMod.LOGGER.warn("[ForgeAIP] WebSocket connect failed: {}", ex.getMessage());
                        scheduleReconnect();
                    } else {
                        webSocket = ws;
                        connected = true;
                        AuxMod.LOGGER.info("[ForgeAIP] WebSocket connected.");
                    }
                });
    }

    /** Disconnects the WebSocket intentionally (e.g., on logout). */
    public void disconnect() {
        intentionalClose = true;
        connected = false;
        if (webSocket != null) {
            webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "logout").exceptionally(e -> null);
            webSocket = null;
        }
        botStatuses.clear();
    }

    // -------------------------------------------------------------------------
    // HTTP helpers
    // -------------------------------------------------------------------------

    /**
     * Async HTTP POST with a JSON body. Returns a CompletableFuture with the
     * response body string, or an exceptionally-completed future on failure.
     */
    public CompletableFuture<String> postJson(String path, String body) {
        String url = ForgeAIPConfig.getOrchestratorUrl() + path;
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(body != null
                        ? HttpRequest.BodyPublishers.ofString(body)
                        : HttpRequest.BodyPublishers.noBody())
                .build();
        return httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .thenApply(HttpResponse::body)
                .exceptionally(ex -> {
                    AuxMod.LOGGER.warn("[ForgeAIP] POST {} failed: {}", path, ex.getMessage());
                    return null;
                });
    }

    /**
     * Async HTTP GET. Returns a CompletableFuture with the response body string.
     */
    public CompletableFuture<String> getJson(String path) {
        String url = ForgeAIPConfig.getOrchestratorUrl() + path;
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(10))
                .header("Accept", "application/json")
                .GET()
                .build();
        return httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .thenApply(HttpResponse::body)
                .exceptionally(ex -> {
                    AuxMod.LOGGER.warn("[ForgeAIP] GET {} failed: {}", path, ex.getMessage());
                    return null;
                });
    }

    /**
     * Async HTTP DELETE. Returns a CompletableFuture with the response body string.
     */
    public CompletableFuture<String> deleteJson(String path) {
        String url = ForgeAIPConfig.getOrchestratorUrl() + path;
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(10))
                .method("DELETE", HttpRequest.BodyPublishers.noBody())
                .build();
        return httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .thenApply(HttpResponse::body)
                .exceptionally(ex -> {
                    AuxMod.LOGGER.warn("[ForgeAIP] DELETE {} failed: {}", path, ex.getMessage());
                    return null;
                });
    }

    // -------------------------------------------------------------------------
    // Reconnect
    // -------------------------------------------------------------------------

    private void scheduleReconnect() {
        if (intentionalClose) return;
        AuxMod.LOGGER.info("[ForgeAIP] Scheduling WebSocket reconnect in 5s...");
        scheduler.schedule(() -> {
            if (!connected && !intentionalClose) {
                connect();
            }
        }, 5, TimeUnit.SECONDS);
    }

    // -------------------------------------------------------------------------
    // WebSocket listener
    // -------------------------------------------------------------------------

    private class WsListener implements WebSocket.Listener {

        private final StringBuilder textAccumulator = new StringBuilder();

        @Override
        public void onOpen(WebSocket ws) {
            connected = true;
            webSocket = ws;
            ws.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            textAccumulator.append(data);
            if (last) {
                String message = textAccumulator.toString();
                textAccumulator.setLength(0);
                ws.request(1);
                handleMessage(message);
            } else {
                ws.request(1);
            }
            return null;
        }

        @Override
        public CompletionStage<?> onPing(WebSocket ws, ByteBuffer message) {
            ws.sendPong(message);
            ws.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
            connected = false;
            webSocket = null;
            AuxMod.LOGGER.info("[ForgeAIP] WebSocket closed ({}): {}", statusCode, reason);
            scheduleReconnect();
            return null;
        }

        @Override
        public void onError(WebSocket ws, Throwable error) {
            connected = false;
            webSocket = null;
            AuxMod.LOGGER.warn("[ForgeAIP] WebSocket error: {}", error.getMessage());
            scheduleReconnect();
        }
    }

    // -------------------------------------------------------------------------
    // Message dispatch
    // -------------------------------------------------------------------------

    private void handleMessage(String json) {
        // Notify all registered listeners with the raw JSON
        for (Consumer<String> listener : messageListeners) {
            try {
                listener.accept(json);
            } catch (Exception e) {
                AuxMod.LOGGER.warn("[ForgeAIP] Listener error: {}", e.getMessage());
            }
        }

        // Parse the event type and update botStatuses when relevant
        try {
            String type = extractStringField(json, "type");
            if (type == null) return;

            switch (type) {
                case "init": {
                    // Initial snapshot sent when WebSocket connects — populate all bots at once.
                    // Event: { type:"init", bots:[{id, online, mode, position:{x,y,z}, health, food, ...}], logs:{} }
                    List<String> botJsons = extractJsonArray(json, "bots");
                    for (String botJson : botJsons) {
                        // init uses "id" field; parseBotStatus fills in all other fields
                        String id = extractStringField(botJson, "id");
                        if (id == null || id.isEmpty()) continue;
                        BotStatus status = parseBotStatus(botJson);
                        status.botId = id;
                        botStatuses.put(id, status);
                    }
                    break;
                }
                case "bot_status": {
                    // Event: { type:"bot_status", botId:"AI_Bot_01", data:{position:{x,y,z}, health, food, ...} }
                    // botId is at the TOP LEVEL, not inside data.
                    String botId = extractStringField(json, "botId");
                    String data = extractObjectField(json, "data");
                    if (botId != null && !botId.isEmpty() && data != null) {
                        BotStatus status = parseBotStatus(data);
                        status.botId = botId;
                        botStatuses.put(botId, status);
                    }
                    break;
                }
                case "bot_connected": {
                    // Event: { type:"bot_connected", botId:"AI_Bot_01" }
                    // Add placeholder so the bot appears immediately (status fills in within 5s).
                    String botId = extractStringField(json, "botId");
                    if (botId != null && !botId.isEmpty() && !botStatuses.containsKey(botId)) {
                        BotStatus placeholder = new BotStatus();
                        placeholder.botId = botId;
                        botStatuses.put(botId, placeholder);
                    }
                    break;
                }
                case "bot_disconnected": {
                    // Event: { type:"bot_disconnected", botId:"AI_Bot_01" }
                    // botId is at the TOP LEVEL, not inside a data object.
                    String botId = extractStringField(json, "botId");
                    if (botId != null) botStatuses.remove(botId);
                    break;
                }
                default:
                    break;
            }
        } catch (Exception e) {
            AuxMod.LOGGER.debug("[ForgeAIP] handleMessage parse error: {}", e.getMessage());
        }
    }

    // -------------------------------------------------------------------------
    // Minimal JSON helpers (no external library)
    // -------------------------------------------------------------------------

    /**
     * Parses a BotStatus from a JSON object string. Field extraction is done
     * manually to avoid any external JSON dependency.
     */
    private BotStatus parseBotStatus(String json) {
        BotStatus s = new BotStatus();
        // botId / id — caller overwrites this for event types that carry botId separately
        s.botId = firstNonNull(extractStringField(json, "botId"), extractStringField(json, "id"), "");
        s.health = extractDouble(json, "health");
        s.food = extractDouble(json, "food");
        // Position is nested: { "position": { "x": ..., "y": ..., "z": ... } }
        // Fall back to flat x/y/z for forwards-compat if structure changes.
        String posObj = extractObjectField(json, "position");
        if (posObj != null) {
            s.x = extractDouble(posObj, "x");
            s.y = extractDouble(posObj, "y");
            s.z = extractDouble(posObj, "z");
        } else {
            s.x = extractDouble(json, "x");
            s.y = extractDouble(json, "y");
            s.z = extractDouble(json, "z");
        }
        s.dimension = firstNonNull(extractStringField(json, "dimension"), "overworld");
        s.isExecuting = extractBoolean(json, "isExecuting");

        // currentAction: try direct field first, then derive from actionQueue
        String ca = extractStringField(json, "currentAction");
        if (ca != null && !ca.isEmpty()) {
            s.currentAction = ca;
        } else {
            // Try to extract first action from actionQueue array
            s.currentAction = extractFirstActionFromQueue(json);
        }
        return s;
    }

    /**
     * Extracts a JSON array field and returns a list of element strings (each a raw JSON object).
     * Only handles arrays of objects ({...}), not primitives.
     */
    private List<String> extractJsonArray(String json, String key) {
        List<String> result = new ArrayList<>();
        if (json == null) return result;
        String search = "\"" + key + "\"";
        int ki = json.indexOf(search);
        if (ki < 0) return result;
        int arrStart = json.indexOf('[', ki + search.length());
        if (arrStart < 0) return result;
        int arrEnd = findMatchingBracket(json, arrStart, '[', ']');
        if (arrEnd < 0) return result;
        String arr = json.substring(arrStart + 1, arrEnd).trim();
        int pos = 0;
        while (pos < arr.length()) {
            // Skip commas and whitespace
            while (pos < arr.length() && (arr.charAt(pos) == ',' || Character.isWhitespace(arr.charAt(pos)))) pos++;
            if (pos >= arr.length()) break;
            if (arr.charAt(pos) == '{') {
                int end = findMatchingBracket(arr, pos, '{', '}');
                if (end < 0) break;
                result.add(arr.substring(pos, end + 1));
                pos = end + 1;
            } else {
                break; // non-object element; stop
            }
        }
        return result;
    }

    private String extractFirstActionFromQueue(String json) {
        // Find "actionQueue":[...]
        String key = "\"actionQueue\"";
        int ki = json.indexOf(key);
        if (ki < 0) return "idle";
        int arrStart = json.indexOf('[', ki + key.length());
        if (arrStart < 0) return "idle";
        int arrEnd = findMatchingBracket(json, arrStart, '[', ']');
        if (arrEnd < 0) return "idle";
        String arr = json.substring(arrStart + 1, arrEnd).trim();
        if (arr.isEmpty()) return "idle";
        // Find first object
        int objStart = arr.indexOf('{');
        if (objStart < 0) return "idle";
        int objEnd = findMatchingBracket(arr, objStart, '{', '}');
        if (objEnd < 0) return "idle";
        String firstObj = arr.substring(objStart, objEnd + 1);
        String action = extractStringField(firstObj, "action");
        return action != null ? action : "idle";
    }

    private int findMatchingBracket(String s, int open, char openCh, char closeCh) {
        int depth = 0;
        for (int i = open; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == openCh) depth++;
            else if (c == closeCh) {
                depth--;
                if (depth == 0) return i;
            }
        }
        return -1;
    }

    /** Extract a top-level string field value from a flat JSON object string. */
    public static String extractStringField(String json, String key) {
        if (json == null) return null;
        String search = "\"" + key + "\"";
        int ki = json.indexOf(search);
        if (ki < 0) return null;
        int colon = json.indexOf(':', ki + search.length());
        if (colon < 0) return null;
        // skip whitespace
        int p = colon + 1;
        while (p < json.length() && Character.isWhitespace(json.charAt(p))) p++;
        if (p >= json.length()) return null;
        if (json.charAt(p) == '"') {
            int q2 = json.indexOf('"', p + 1);
            if (q2 < 0) return null;
            return json.substring(p + 1, q2);
        }
        return null;
    }

    /** Extract a top-level object field (returns the raw {...} string). */
    public static String extractObjectField(String json, String key) {
        if (json == null) return null;
        String search = "\"" + key + "\"";
        int ki = json.indexOf(search);
        if (ki < 0) return null;
        int colon = json.indexOf(':', ki + search.length());
        if (colon < 0) return null;
        int p = colon + 1;
        while (p < json.length() && Character.isWhitespace(json.charAt(p))) p++;
        if (p >= json.length()) return null;
        char start = json.charAt(p);
        if (start == '{') {
            int end = findMatchingBracketStatic(json, p, '{', '}');
            if (end < 0) return null;
            return json.substring(p, end + 1);
        }
        return null;
    }

    private static int findMatchingBracketStatic(String s, int open, char openCh, char closeCh) {
        int depth = 0;
        for (int i = open; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == openCh) depth++;
            else if (c == closeCh) {
                depth--;
                if (depth == 0) return i;
            }
        }
        return -1;
    }

    /** Extract a top-level numeric field from a JSON object string. */
    public static double extractDouble(String json, String key) {
        if (json == null) return 0.0;
        String search = "\"" + key + "\"";
        int ki = json.indexOf(search);
        if (ki < 0) return 0.0;
        int colon = json.indexOf(':', ki + search.length());
        if (colon < 0) return 0.0;
        int p = colon + 1;
        while (p < json.length() && Character.isWhitespace(json.charAt(p))) p++;
        int end = p;
        while (end < json.length()) {
            char c = json.charAt(end);
            if (c == ',' || c == '}' || c == ']' || Character.isWhitespace(c)) break;
            end++;
        }
        String val = json.substring(p, end).trim();
        if (val.isEmpty()) return 0.0;
        try {
            return Double.parseDouble(val);
        } catch (NumberFormatException e) {
            return 0.0;
        }
    }

    /** Extract a top-level boolean field from a JSON object string. */
    public static boolean extractBoolean(String json, String key) {
        if (json == null) return false;
        String search = "\"" + key + "\"";
        int ki = json.indexOf(search);
        if (ki < 0) return false;
        int colon = json.indexOf(':', ki + search.length());
        if (colon < 0) return false;
        int p = colon + 1;
        while (p < json.length() && Character.isWhitespace(json.charAt(p))) p++;
        return json.startsWith("true", p);
    }

    @SafeVarargs
    private static <T> T firstNonNull(T... values) {
        for (T v : values) {
            if (v != null) return v;
        }
        return null;
    }

    /** Escape a string for inclusion in a JSON value. */
    public static String jsonEscape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }
}
