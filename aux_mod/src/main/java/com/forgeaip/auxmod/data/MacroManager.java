package com.forgeaip.auxmod.data;

import com.forgeaip.auxmod.AuxMod;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Manages procedure macros (condition + action pairs) stored in
 * {@code config/forgeaip_macros.json}.
 *
 * <p>No external JSON library is used; serialisation is done manually.
 */
public class MacroManager {

    private static MacroManager INSTANCE;

    private final List<Macro> macros = new CopyOnWriteArrayList<>();

    private static final Path SAVE_PATH = Paths.get("config", "forgeaip_macros.json");

    private MacroManager() {}

    public static MacroManager getInstance() {
        if (INSTANCE == null) {
            INSTANCE = new MacroManager();
        }
        return INSTANCE;
    }

    // -------------------------------------------------------------------------
    // Macro record
    // -------------------------------------------------------------------------

    public static class Macro {
        /** Human-readable trigger condition, e.g. "health < 6". */
        public String condition;
        /** JSON action string, e.g. [{"action":"eat"}]. */
        public String action;

        public Macro(String condition, String action) {
            this.condition = condition != null ? condition : "";
            this.action = action != null ? action : "[]";
        }

        public String toJson() {
            return String.format("{\"condition\":\"%s\",\"action\":\"%s\"}",
                    escapeJson(condition), escapeJson(action));
        }

        private static String escapeJson(String s) {
            return s.replace("\\", "\\\\")
                    .replace("\"", "\\\"")
                    .replace("\n", "\\n")
                    .replace("\r", "\\r")
                    .replace("\t", "\\t");
        }

        @Override
        public String toString() {
            return "Macro{condition='" + condition + "', action='" + action + "'}";
        }
    }

    // -------------------------------------------------------------------------
    // CRUD
    // -------------------------------------------------------------------------

    public void addMacro(Macro macro) {
        macros.add(macro);
        save();
    }

    public void removeMacro(int index) {
        if (index >= 0 && index < macros.size()) {
            macros.remove(index);
            save();
        }
    }

    public void updateMacro(int index, Macro macro) {
        if (index >= 0 && index < macros.size()) {
            macros.set(index, macro);
            save();
        }
    }

    public List<Macro> getMacros() {
        return Collections.unmodifiableList(macros);
    }

    public int size() {
        return macros.size();
    }

    // -------------------------------------------------------------------------
    // Persistence
    // -------------------------------------------------------------------------

    public void load() {
        try {
            if (!Files.exists(SAVE_PATH)) {
                save(); // create empty file
                return;
            }
            String content = new String(Files.readAllBytes(SAVE_PATH), StandardCharsets.UTF_8).trim();
            if (content.isEmpty() || content.equals("[]")) return;
            List<Macro> loaded = parseJsonArray(content);
            macros.clear();
            macros.addAll(loaded);
            AuxMod.LOGGER.info("[ForgeAIP] Loaded {} macros.", macros.size());
        } catch (Exception e) {
            AuxMod.LOGGER.warn("[ForgeAIP] Failed to load macros: {}", e.getMessage());
        }
    }

    public void save() {
        try {
            Files.createDirectories(SAVE_PATH.getParent());
            StringBuilder sb = new StringBuilder("[\n");
            for (int i = 0; i < macros.size(); i++) {
                sb.append("  ").append(macros.get(i).toJson());
                if (i < macros.size() - 1) sb.append(",");
                sb.append("\n");
            }
            sb.append("]");
            Files.write(SAVE_PATH, sb.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            AuxMod.LOGGER.warn("[ForgeAIP] Failed to save macros: {}", e.getMessage());
        }
    }

    // -------------------------------------------------------------------------
    // Simple JSON parser
    // -------------------------------------------------------------------------

    private List<Macro> parseJsonArray(String json) {
        List<Macro> result = new ArrayList<>();
        int start = json.indexOf('[');
        int end = json.lastIndexOf(']');
        if (start < 0 || end < 0) return result;
        String inner = json.substring(start + 1, end).trim();
        if (inner.isEmpty()) return result;

        List<String> objects = splitTopLevelObjects(inner);
        for (String obj : objects) {
            Macro m = parseMacroObject(obj.trim());
            if (m != null) result.add(m);
        }
        return result;
    }

    private List<String> splitTopLevelObjects(String s) {
        List<String> parts = new ArrayList<>();
        int depth = 0;
        int objStart = -1;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '{') {
                if (depth == 0) objStart = i;
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0 && objStart >= 0) {
                    parts.add(s.substring(objStart, i + 1));
                    objStart = -1;
                }
            }
        }
        return parts;
    }

    private Macro parseMacroObject(String obj) {
        try {
            String condition = extractString(obj, "condition");
            String action = extractString(obj, "action");
            return new Macro(condition, action);
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
        // Walk forward handling escape sequences
        StringBuilder sb = new StringBuilder();
        int i = q1 + 1;
        while (i < json.length()) {
            char c = json.charAt(i);
            if (c == '\\' && i + 1 < json.length()) {
                char next = json.charAt(i + 1);
                switch (next) {
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    default: sb.append(next); break;
                }
                i += 2;
            } else if (c == '"') {
                break;
            } else {
                sb.append(c);
                i++;
            }
        }
        return sb.toString();
    }
}
