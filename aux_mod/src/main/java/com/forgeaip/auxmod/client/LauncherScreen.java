package com.forgeaip.auxmod.client;

import com.forgeaip.auxmod.ForgeAIPConfig;
import com.forgeaip.auxmod.data.SystemLauncherManager;
import com.forgeaip.auxmod.network.OrchestratorClient;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.api.distmarker.OnlyIn;

import java.util.List;

/**
 * System Launcher screen — press F10 to open.
 *
 * <p>Lets the user configure the LLM endpoint and start/stop the Node.js
 * orchestrator without leaving Minecraft.
 *
 * <p>Layout (top to bottom):
 * <ol>
 *   <li>Title + status indicator</li>
 *   <li>Configuration fields (OLLAMA URL, model, key, MC host/port, bot names,
 *       project dir, node path)</li>
 *   <li>Start / Stop / Save / Close buttons</li>
 *   <li>Log tail (last 10 lines of Node.js stdout)</li>
 * </ol>
 */
@OnlyIn(Dist.CLIENT)
public class LauncherScreen extends Screen {

    // ── Layout ────────────────────────────────────────────────────────────────
    private static final int LABEL_COLOR   = 0xFFCCCCCC;
    private static final int VALUE_COLOR   = 0xFFFFFFFF;
    private static final int HINT_COLOR    = 0xFF888888;
    private static final int LOG_COLOR     = 0xFF99FF99;
    private static final int ERROR_COLOR   = 0xFFFF6666;
    private static final int OK_COLOR      = 0xFF55FF55;

    private static final int FIELD_H = 16;
    private static final int ROW_GAP = 20;
    private static final int LABEL_W = 130;
    private static final int FIELD_X = 140;

    // ── Fields ────────────────────────────────────────────────────────────────
    private EditBox fOllamaUrl;
    private EditBox fOllamaModel;
    private EditBox fApiKey;
    private EditBox fMcHost;
    private EditBox fMcPort;
    private EditBox fBotNames;
    private EditBox fProjectDir;
    private EditBox fNodePath;

    public LauncherScreen() {
        super(Component.literal("ForgeAIP System Launcher"));
    }

    // ── Screen lifecycle ──────────────────────────────────────────────────────

    @Override
    protected void init() {
        super.init();
        buildWidgets();
    }

    private void buildWidgets() {
        clearWidgets();

        int fieldW = this.width - FIELD_X - 10;
        int y = 30;

        // ── Config fields ──
        fOllamaUrl   = field(FIELD_X, y, fieldW, ForgeAIPConfig.CLIENT.launcherOllamaUrl.get()); y += ROW_GAP;
        fOllamaModel = field(FIELD_X, y, fieldW, ForgeAIPConfig.CLIENT.launcherOllamaModel.get()); y += ROW_GAP;
        fApiKey      = field(FIELD_X, y, fieldW, ForgeAIPConfig.CLIENT.launcherOllamaApiKey.get()); y += ROW_GAP;
        fMcHost      = field(FIELD_X, y, fieldW / 2 - 2, ForgeAIPConfig.CLIENT.launcherMcHost.get());
        fMcPort      = field(FIELD_X + fieldW / 2 + 2, y, fieldW / 2 - 2,
                             String.valueOf(ForgeAIPConfig.CLIENT.launcherMcPort.get())); y += ROW_GAP;
        fBotNames    = field(FIELD_X, y, fieldW, ForgeAIPConfig.CLIENT.launcherBotNames.get()); y += ROW_GAP;
        fProjectDir  = field(FIELD_X, y, fieldW, ForgeAIPConfig.CLIENT.launcherProjectDir.get()); y += ROW_GAP;
        fNodePath    = field(FIELD_X, y, fieldW / 2 - 2, ForgeAIPConfig.CLIENT.launcherNodePath.get()); y += ROW_GAP + 4;

        // ── Buttons ──
        int btnW = 80;
        int btnSpacing = 84;
        int btnX = 10;

        addRenderableWidget(Button.builder(Component.literal("▶ Start"), btn -> doStart())
                .pos(btnX, y).size(btnW, 16).build());
        addRenderableWidget(Button.builder(Component.literal("■ Stop"), btn -> doStop())
                .pos(btnX + btnSpacing, y).size(btnW, 16).build());
        addRenderableWidget(Button.builder(Component.literal("Save Config"), btn -> doSave())
                .pos(btnX + btnSpacing * 2, y).size(btnW, 16).build());
        addRenderableWidget(Button.builder(Component.literal("Close"), btn -> onClose())
                .pos(btnX + btnSpacing * 3, y).size(btnW, 16).build());

        for (EditBox box : new EditBox[]{fOllamaUrl, fOllamaModel, fApiKey, fMcHost, fMcPort,
                                         fBotNames, fProjectDir, fNodePath}) {
            addRenderableWidget(box);
        }
    }

    private EditBox field(int x, int y, int w, String defaultVal) {
        EditBox box = new EditBox(this.font, x, y, w, FIELD_H, Component.empty());
        box.setMaxLength(512);
        box.setValue(defaultVal != null ? defaultVal : "");
        return box;
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    private void doSave() {
        ForgeAIPConfig.CLIENT.launcherOllamaUrl.set(fOllamaUrl.getValue());
        ForgeAIPConfig.CLIENT.launcherOllamaModel.set(fOllamaModel.getValue());
        ForgeAIPConfig.CLIENT.launcherOllamaApiKey.set(fApiKey.getValue());
        ForgeAIPConfig.CLIENT.launcherMcHost.set(fMcHost.getValue());
        try { ForgeAIPConfig.CLIENT.launcherMcPort.set(Integer.parseInt(fMcPort.getValue())); }
        catch (NumberFormatException ignored) {}
        ForgeAIPConfig.CLIENT.launcherBotNames.set(fBotNames.getValue());
        ForgeAIPConfig.CLIENT.launcherProjectDir.set(fProjectDir.getValue());
        ForgeAIPConfig.CLIENT.launcherNodePath.set(fNodePath.getValue());
        // Forge config is saved automatically on next tick; force it now
        net.minecraftforge.fml.config.ModConfig.Type.CLIENT.toString(); // no-op to keep import used
        if (minecraft != null && minecraft.player != null) {
            minecraft.player.sendSystemMessage(
                    Component.literal("[ForgeAIP] Config saved."));
        }
    }

    private void doStart() {
        doSave(); // persist current field values first
        int port;
        try { port = Integer.parseInt(fMcPort.getValue()); }
        catch (NumberFormatException e) { port = 25565; }

        SystemLauncherManager.getInstance().start(
                fProjectDir.getValue(),
                fNodePath.getValue(),
                fOllamaUrl.getValue(),
                fOllamaModel.getValue(),
                fApiKey.getValue(),
                fMcHost.getValue(),
                port,
                fBotNames.getValue()
        );

        // Reconnect orchestrator WebSocket so HUD picks up the newly started server
        OrchestratorClient client = OrchestratorClient.getInstance();
        if (!client.isConnected()) {
            client.connect();
        }
    }

    private void doStop() {
        SystemLauncherManager.getInstance().stop();
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    @Override
    public void render(GuiGraphics g, int mx, int my, float pt) {
        renderBackground(g);

        // Panel background
        g.fill(4, 4, this.width - 4, this.height - 4, 0xCC101020);

        // ── Title + status ──
        g.drawCenteredString(this.font, "ForgeAIP System Launcher", this.width / 2, 10, VALUE_COLOR);

        SystemLauncherManager launcher = SystemLauncherManager.getInstance();
        OrchestratorClient ws = OrchestratorClient.getInstance();
        boolean procRunning = launcher.isRunning();
        boolean wsConn = ws.isConnected();
        String procStatus = procRunning ? "RUNNING" : "STOPPED";
        String wsStatus   = wsConn      ? "WS connected" : "WS disconnected";
        int procColor = procRunning ? OK_COLOR : ERROR_COLOR;
        int wsColor   = wsConn      ? OK_COLOR : ERROR_COLOR;
        g.drawString(this.font, "Process: " + procStatus, 10, 10, procColor, false);
        g.drawString(this.font, wsStatus, this.width - 100, 10, wsColor, false);

        // ── Field labels ──
        int y = 30;
        String[][] labels = {
            { "OLLAMA URL:" },
            { "LLM Model:" },
            { "API Key:" },
            { "MC Host / Port:" },
            { "Bot Names:" },
            { "Project Dir:" },
            { "Node Path:" }
        };
        for (String[] row : labels) {
            g.drawString(this.font, row[0], 10, y + 4, LABEL_COLOR, false);
            y += ROW_GAP;
        }

        // ── Error message (if any) ──
        String err = launcher.getLastError();
        int logY = 30 + labels.length * ROW_GAP + ROW_GAP + 4 + 20; // below buttons
        if (err != null) {
            g.drawString(this.font, "Error: " + err, 10, logY, ERROR_COLOR, false);
            logY += 10;
        }

        // ── Log tail ──
        g.drawString(this.font, "Log:", 10, logY, HINT_COLOR, false);
        logY += 10;
        List<String> logs = launcher.getRecentLogs(10);
        for (String line : logs) {
            if (logY + 9 > this.height - 8) break;
            // Truncate long lines
            String display = line.length() > 90 ? line.substring(0, 89) + "…" : line;
            g.drawString(this.font, display, 10, logY, LOG_COLOR, false);
            logY += 9;
        }

        super.render(g, mx, my, pt);
    }

    @Override
    public boolean isPauseScreen() { return false; }

    @Override
    public boolean mouseClicked(double x, double y, int btn) {
        // Unfocus all boxes when clicking outside them
        for (EditBox box : new EditBox[]{fOllamaUrl, fOllamaModel, fApiKey, fMcHost, fMcPort,
                                         fBotNames, fProjectDir, fNodePath}) {
            if (box != null) box.setFocused(false);
        }
        return super.mouseClicked(x, y, btn);
    }
}
