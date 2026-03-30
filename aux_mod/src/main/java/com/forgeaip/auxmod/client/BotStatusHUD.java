package com.forgeaip.auxmod.client;

import com.forgeaip.auxmod.AuxMod;
import com.forgeaip.auxmod.ForgeAIPConfig;
import com.forgeaip.auxmod.data.BotStatus;
import com.forgeaip.auxmod.network.OrchestratorClient;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.RenderGuiOverlayEvent;
import net.minecraftforge.client.gui.overlay.VanillaGuiOverlay;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

import java.util.Collection;

/**
 * Renders the Bot Status HUD overlay in the top-left corner.
 *
 * <p>Registered on the Forge event bus; toggled via {@link ClientEvents#hudVisible}.
 */
@Mod.EventBusSubscriber(modid = AuxMod.MOD_ID, value = Dist.CLIENT)
public class BotStatusHUD {

    /** Background colour: semi-transparent dark grey (ARGB). */
    private static final int BG_COLOR = 0x88000000;
    /** Text colour: bright white. */
    private static final int TEXT_COLOR = 0xFFFFFFFF;
    /** Pale green for the "connected" dot. */
    private static final int DOT_CONNECTED = 0xFF55FF55;
    /** Pale red when disconnected. */
    private static final int DOT_DISCONNECTED = 0xFFFF5555;

    private static final int PADDING = 3;
    private static final int LINE_HEIGHT = 10;

    /** Whether the HUD overlay is currently visible. Toggled by F8. */
    private static volatile boolean visible = true;

    public static boolean isVisible() { return visible; }
    public static void toggleVisible() { visible = !visible; }

    // -------------------------------------------------------------------------
    // Render event
    // -------------------------------------------------------------------------

    @SubscribeEvent
    public static void onRenderOverlay(RenderGuiOverlayEvent.Post event) {
        // Only fire after the chat overlay (arbitrary but consistent ordering)
        if (event.getOverlay() != VanillaGuiOverlay.CHAT_PANEL.type()) return;

        if (!ForgeAIPConfig.CLIENT.hudEnabled.get()) return;
        if (!visible) return;

        Minecraft mc = Minecraft.getInstance();
        if (mc.options.hideGui) return;
        if (mc.screen != null) return; // don't draw over open screens

        GuiGraphics graphics = event.getGuiGraphics();
        OrchestratorClient client = OrchestratorClient.getInstance();
        Collection<BotStatus> bots = client.botStatuses.values();

        int x = ForgeAIPConfig.CLIENT.hudX.get();
        int y = ForgeAIPConfig.CLIENT.hudY.get();

        // Determine max line width for background
        int lineCount = 1 + bots.size(); // header + bot lines
        int maxWidth = 160; // minimum width

        // Header line
        String header = bots.isEmpty()
                ? "ForgeAIP | no bots"
                : "ForgeAIP | " + bots.size() + " bot(s)";

        // Draw background
        int bgW = maxWidth + PADDING * 2;
        int bgH = lineCount * LINE_HEIGHT + PADDING * 2;
        graphics.fill(x - PADDING, y - PADDING, x - PADDING + bgW, y - PADDING + bgH, BG_COLOR);

        // Connection indicator dot (4x4)
        int dotColor = client.isConnected() ? DOT_CONNECTED : DOT_DISCONNECTED;
        graphics.fill(x, y + 1, x + 4, y + 5, dotColor);

        // Header text (offset to make room for dot)
        graphics.drawString(mc.font, header, x + 6, y, TEXT_COLOR, false);
        y += LINE_HEIGHT;

        // Per-bot lines
        for (BotStatus bot : bots) {
            String line = formatBotLine(bot);
            graphics.drawString(mc.font, line, x, y, TEXT_COLOR, false);
            y += LINE_HEIGHT;
        }
    }

    // -------------------------------------------------------------------------
    // Formatting
    // -------------------------------------------------------------------------

    private static String formatBotLine(BotStatus bot) {
        int px = (int) Math.round(bot.x);
        int py = (int) Math.round(bot.y);
        int pz = (int) Math.round(bot.z);
        String action = (bot.currentAction != null && !bot.currentAction.isEmpty())
                ? bot.currentAction : "idle";
        // Trim action to 12 chars to keep line short
        if (action.length() > 12) action = action.substring(0, 11) + ".";
        return String.format("[%s] HP:%.0f FD:%.0f (%d,%d,%d) %s",
                bot.botId, bot.health, bot.food, px, py, pz, action);
    }
}
