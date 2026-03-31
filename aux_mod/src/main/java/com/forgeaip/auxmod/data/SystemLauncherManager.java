package com.forgeaip.auxmod.data;

import com.forgeaip.auxmod.AuxMod;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Manages the lifecycle of the Node.js orchestrator process (node index.js).
 *
 * <p>Call {@link #start} to launch the system. The process's stdout/stderr
 * is captured and exposed via {@link #getRecentLogs}. Call {@link #stop} to
 * kill the process gracefully.
 */
public class SystemLauncherManager {

    private static final SystemLauncherManager INSTANCE = new SystemLauncherManager();
    public static SystemLauncherManager getInstance() { return INSTANCE; }

    private static final int MAX_LOG_LINES = 120;

    private Process nodeProcess = null;
    private final CopyOnWriteArrayList<String> logLines = new CopyOnWriteArrayList<>();
    private volatile String lastError = null;

    private SystemLauncherManager() {}

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /** Returns true if the Node.js process is currently alive. */
    public boolean isRunning() {
        return nodeProcess != null && nodeProcess.isAlive();
    }

    /** Returns the last error message from a failed start attempt, or null. */
    public String getLastError() { return lastError; }

    /**
     * Writes a minimal .env file and starts {@code node index.js} in
     * {@code projectDir}.
     *
     * @param projectDir   absolute path to the forge1201AIP project
     * @param nodePath     path / name of the node executable
     * @param ollamaUrl    value for OLLAMA_URL env var
     * @param ollamaModel  value for OLLAMA_MODEL env var
     * @param ollamaApiKey value for OLLAMA_API_KEY env var (may be empty)
     * @param mcHost       value for MC_HOST env var
     * @param mcPort       value for MC_PORT env var
     * @param botNames     value for BOT_NAMES env var (comma-separated)
     */
    public void start(String projectDir, String nodePath,
                      String ollamaUrl, String ollamaModel, String ollamaApiKey,
                      String mcHost, int mcPort, String botNames) {
        lastError = null;
        if (isRunning()) {
            AuxMod.LOGGER.warn("[ForgeAIP] Launcher: already running — ignoring start request.");
            return;
        }

        // Validate project directory
        if (projectDir == null || projectDir.trim().isEmpty()) {
            lastError = "Project directory is not configured.";
            AuxMod.LOGGER.error("[ForgeAIP] Launcher: {}", lastError);
            return;
        }
        File dir = new File(projectDir.trim());
        if (!dir.isDirectory()) {
            lastError = "Project directory does not exist: " + projectDir;
            AuxMod.LOGGER.error("[ForgeAIP] Launcher: {}", lastError);
            return;
        }
        File indexJs = new File(dir, "index.js");
        if (!indexJs.exists()) {
            lastError = "index.js not found in: " + projectDir;
            AuxMod.LOGGER.error("[ForgeAIP] Launcher: {}", lastError);
            return;
        }

        // Write .env (merge with existing to preserve SENTRY_DSN etc.)
        try {
            writeEnvFile(dir, ollamaUrl, ollamaModel, ollamaApiKey, mcHost, mcPort, botNames);
        } catch (IOException e) {
            lastError = "Failed to write .env: " + e.getMessage();
            AuxMod.LOGGER.error("[ForgeAIP] Launcher: {}", lastError);
            return;
        }

        // Build process
        String nodeExec = (nodePath == null || nodePath.trim().isEmpty()) ? "node" : nodePath.trim();
        try {
            ProcessBuilder pb = new ProcessBuilder(nodeExec, "index.js");
            pb.directory(dir);
            pb.redirectErrorStream(true); // merge stderr into stdout
            // Pass a non-interactive stdin so the Sentry CLI prompt is skipped
            pb.redirectInput(ProcessBuilder.Redirect.from(new File(
                    System.getProperty("os.name", "").toLowerCase().contains("win") ? "NUL" : "/dev/null")));

            logLines.clear();
            nodeProcess = pb.start();
            AuxMod.LOGGER.info("[ForgeAIP] Launcher: started '{}' in {}", nodeExec + " index.js", projectDir);
            addLog("[ForgeAIP] System started. Waiting for bots to connect...");

            // Background thread: drain stdout/stderr into logLines
            final Process proc = nodeProcess;
            Thread reader = new Thread(() -> {
                try (BufferedReader br = new BufferedReader(
                        new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = br.readLine()) != null) {
                        addLog(line);
                    }
                } catch (IOException ignored) {}
                addLog("[ForgeAIP] System process exited.");
            }, "ForgeAIP-Launcher-Reader");
            reader.setDaemon(true);
            reader.start();

        } catch (IOException e) {
            lastError = "Failed to start node: " + e.getMessage();
            AuxMod.LOGGER.error("[ForgeAIP] Launcher: {}", lastError);
            nodeProcess = null;
        }
    }

    /** Kills the Node.js process. */
    public void stop() {
        if (nodeProcess != null) {
            nodeProcess.destroyForcibly();
            nodeProcess = null;
            addLog("[ForgeAIP] System stopped.");
            AuxMod.LOGGER.info("[ForgeAIP] Launcher: process stopped.");
        }
    }

    /**
     * Returns a snapshot of the most recent log lines (up to {@code count}).
     * Ordered oldest-first.
     */
    public List<String> getRecentLogs(int count) {
        List<String> copy = new ArrayList<>(logLines);
        int from = Math.max(0, copy.size() - count);
        return copy.subList(from, copy.size());
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    private void addLog(String line) {
        logLines.add(line);
        while (logLines.size() > MAX_LOG_LINES) logLines.remove(0);
    }

    /**
     * Writes (or updates) the .env file in {@code projectDir}.
     * Reads the existing file, replaces known keys, appends any new ones.
     */
    private void writeEnvFile(File projectDir, String ollamaUrl, String ollamaModel,
                               String ollamaApiKey, String mcHost, int mcPort,
                               String botNames) throws IOException {
        Path envPath = Paths.get(projectDir.getAbsolutePath(), ".env");

        // Read existing .env lines
        List<String> lines = new ArrayList<>();
        if (Files.exists(envPath)) {
            lines = new ArrayList<>(Files.readAllLines(envPath, StandardCharsets.UTF_8));
        }

        Map<String, String> updates = new LinkedHashMap<>();
        updates.put("OLLAMA_URL", ollamaUrl != null ? ollamaUrl : "");
        updates.put("OLLAMA_MODEL", ollamaModel != null ? ollamaModel : "gpt-oss:20b-cloud");
        updates.put("OLLAMA_API_KEY", ollamaApiKey != null ? ollamaApiKey : "");
        updates.put("MC_HOST", mcHost != null ? mcHost : "localhost");
        updates.put("MC_PORT", String.valueOf(mcPort));
        updates.put("BOT_NAMES", botNames != null ? botNames : "AI_Bot_01");

        // Update existing lines
        Set<String> written = new HashSet<>();
        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            for (Map.Entry<String, String> e : updates.entrySet()) {
                if (line.startsWith(e.getKey() + "=") || line.startsWith(e.getKey() + " =")) {
                    lines.set(i, e.getKey() + "=" + e.getValue());
                    written.add(e.getKey());
                    break;
                }
            }
        }
        // Append keys not already present
        for (Map.Entry<String, String> e : updates.entrySet()) {
            if (!written.contains(e.getKey())) {
                lines.add(e.getKey() + "=" + e.getValue());
            }
        }

        Files.write(envPath, lines, StandardCharsets.UTF_8);
        AuxMod.LOGGER.info("[ForgeAIP] Launcher: wrote .env to {}", envPath);
    }
}
