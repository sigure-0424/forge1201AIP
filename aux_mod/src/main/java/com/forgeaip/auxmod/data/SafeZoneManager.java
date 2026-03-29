package com.forgeaip.auxmod.data;

import com.forgeaip.auxmod.AuxMod;
import net.minecraft.world.phys.AABB;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Manages safe zone data locally (config/forgeaip_safezones.json).
 * Also tracks zones received from the orchestrator GET /api/safezones.
 */
public class SafeZoneManager {

    private static SafeZoneManager INSTANCE;

    /** Map of zone name -> SafeZone record */
    private final Map<String, SafeZone> zones = new ConcurrentHashMap<>();

    private static final Path SAVE_PATH = Paths.get("config", "forgeaip_safezones.json");

    private SafeZoneManager() {}

    public static SafeZoneManager getInstance() {
        if (INSTANCE == null) {
            INSTANCE = new SafeZoneManager();
        }
        return INSTANCE;
    }

    // -------------------------------------------------------------------------
    // Safe Zone record
    // -------------------------------------------------------------------------

    public static class SafeZone {
        public final String name;
        public final double x1, y1, z1, x2, y2, z2;

        public SafeZone(String name, double x1, double y1, double z1, double x2, double y2, double z2) {
            this.name = name;
            this.x1 = Math.min(x1, x2);
            this.y1 = Math.min(y1, y2);
            this.z1 = Math.min(z1, z2);
            this.x2 = Math.max(x1, x2);
            this.y2 = Math.max(y1, y2);
            this.z2 = Math.max(z1, z2);
        }

        /** Creates a chunk-aligned 16x256x16 zone from a chunk coordinate. */
        public static SafeZone fromChunk(String name, int chunkX, int chunkZ) {
            double x1 = chunkX * 16.0;
            double z1 = chunkZ * 16.0;
            return new SafeZone(name, x1, -64, z1, x1 + 16, 320, z1 + 16);
        }

        public AABB toAABB() {
            return new AABB(x1, y1, z1, x2, y2, z2);
        }

        public boolean contains(double x, double y, double z) {
            return x >= x1 && x <= x2 && y >= y1 && y <= y2 && z >= z1 && z <= z2;
        }

        /**
         * Serialize to a minimal JSON object string (no external library).
         */
        public String toJson() {
            return String.format("{\"name\":\"%s\",\"x1\":%s,\"y1\":%s,\"z1\":%s,\"x2\":%s,\"y2\":%s,\"z2\":%s}",
                    escapeJson(name), x1, y1, z1, x2, y2, z2);
        }

        private static String escapeJson(String s) {
            return s.replace("\\", "\\\\").replace("\"", "\\\"");
        }
    }

    // -------------------------------------------------------------------------
    // CRUD operations
    // -------------------------------------------------------------------------

    public void addZone(SafeZone zone) {
        zones.put(zone.name, zone);
        save();
    }

    public boolean removeZone(String name) {
        boolean removed = zones.remove(name) != null;
        if (removed) save();
        return removed;
    }

    public Collection<SafeZone> getAllZones() {
        return Collections.unmodifiableCollection(zones.values());
    }

    public SafeZone getZone(String name) {
        return zones.get(name);
    }

    /**
     * Returns the first safe zone that contains the given world coordinate, or null.
     */
    public SafeZone findContaining(double x, double y, double z) {
        for (SafeZone zone : zones.values()) {
            if (zone.contains(x, y, z)) return zone;
        }
        return null;
    }

    /**
     * Replaces the entire zone map from an external source (orchestrator GET response).
     */
    public void setZones(List<SafeZone> incoming) {
        zones.clear();
        for (SafeZone z : incoming) {
            zones.put(z.name, z);
        }
        save();
    }

    // -------------------------------------------------------------------------
    // Persistence
    // -------------------------------------------------------------------------

    public void load() {
        try {
            if (!Files.exists(SAVE_PATH)) return;
            String content = new String(Files.readAllBytes(SAVE_PATH), StandardCharsets.UTF_8).trim();
            if (content.isEmpty() || content.equals("[]")) return;
            // Manual JSON array parse — no external library
            List<SafeZone> loaded = parseJsonArray(content);
            for (SafeZone z : loaded) {
                zones.put(z.name, z);
            }
            AuxMod.LOGGER.info("[ForgeAIP] Loaded {} safe zones.", zones.size());
        } catch (Exception e) {
            AuxMod.LOGGER.warn("[ForgeAIP] Failed to load safe zones: {}", e.getMessage());
        }
    }

    public void save() {
        try {
            Files.createDirectories(SAVE_PATH.getParent());
            StringBuilder sb = new StringBuilder("[\n");
            Iterator<SafeZone> it = zones.values().iterator();
            while (it.hasNext()) {
                sb.append("  ").append(it.next().toJson());
                if (it.hasNext()) sb.append(",");
                sb.append("\n");
            }
            sb.append("]");
            Files.write(SAVE_PATH, sb.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            AuxMod.LOGGER.warn("[ForgeAIP] Failed to save safe zones: {}", e.getMessage());
        }
    }

    // -------------------------------------------------------------------------
    // Simple JSON parser for the safe zones array format
    // -------------------------------------------------------------------------

    private List<SafeZone> parseJsonArray(String json) {
        List<SafeZone> result = new ArrayList<>();
        // Strip outer [ ]
        int start = json.indexOf('[');
        int end = json.lastIndexOf(']');
        if (start < 0 || end < 0) return result;
        String inner = json.substring(start + 1, end).trim();
        if (inner.isEmpty()) return result;

        // Split by top-level objects
        List<String> objects = splitTopLevelObjects(inner);
        for (String obj : objects) {
            SafeZone z = parseZoneObject(obj.trim());
            if (z != null) result.add(z);
        }
        return result;
    }

    private List<String> splitTopLevelObjects(String s) {
        List<String> parts = new ArrayList<>();
        int depth = 0;
        int start = -1;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '{') {
                if (depth == 0) start = i;
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0 && start >= 0) {
                    parts.add(s.substring(start, i + 1));
                    start = -1;
                }
            }
        }
        return parts;
    }

    private SafeZone parseZoneObject(String obj) {
        try {
            String name = extractString(obj, "name");
            double x1 = extractDouble(obj, "x1");
            double y1 = extractDouble(obj, "y1");
            double z1 = extractDouble(obj, "z1");
            double x2 = extractDouble(obj, "x2");
            double y2 = extractDouble(obj, "y2");
            double z2 = extractDouble(obj, "z2");
            if (name == null) return null;
            return new SafeZone(name, x1, y1, z1, x2, y2, z2);
        } catch (Exception e) {
            return null;
        }
    }

    private String extractString(String json, String key) {
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

    private double extractDouble(String json, String key) {
        String search = "\"" + key + "\"";
        int ki = json.indexOf(search);
        if (ki < 0) return 0;
        int colon = json.indexOf(':', ki + search.length());
        if (colon < 0) return 0;
        int valueStart = colon + 1;
        while (valueStart < json.length() && (json.charAt(valueStart) == ' ' || json.charAt(valueStart) == '\n')) {
            valueStart++;
        }
        int valueEnd = valueStart;
        while (valueEnd < json.length()) {
            char c = json.charAt(valueEnd);
            if (c == ',' || c == '}' || c == ']' || c == ' ' || c == '\n') break;
            valueEnd++;
        }
        return Double.parseDouble(json.substring(valueStart, valueEnd).trim());
    }
}
