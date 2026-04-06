package com.forgeaip.auxmod.client;

import com.forgeaip.auxmod.AuxMod;
import com.forgeaip.auxmod.ForgeAIPConfig;
import com.forgeaip.auxmod.network.OrchestratorClient;
import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.world.phys.Vec3;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.*;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import org.lwjgl.glfw.GLFW;

/**
 * Client-side event handlers: keybind registration, tick-based entity tracking,
 * and login/logout lifecycle management for the OrchestratorClient.
 */
@Mod.EventBusSubscriber(modid = AuxMod.MOD_ID, value = Dist.CLIENT)
public class ClientEvents {

    // F8 = toggle HUD, F9 = open Macro screen, F10 = open Launcher screen
    public static KeyMapping HUD_TOGGLE_KEY;
    public static KeyMapping MACRO_SCREEN_KEY;
    public static KeyMapping LAUNCHER_SCREEN_KEY;

    private static int entityTrackTick = 0;
    private static final int ENTITY_TRACK_INTERVAL = 40; // every 2 seconds (20 ticks/s)

    // -------------------------------------------------------------------------
    // Keybind registration (mod event bus — handled in AuxMod constructor)
    // -------------------------------------------------------------------------

    /**
     * Must be called from the mod event bus during FMLClientSetupEvent (or
     * RegisterKeyMappingsEvent). We expose static fields so AuxMod can call this.
     */
    public static void registerKeyMappings(RegisterKeyMappingsEvent event) {
        HUD_TOGGLE_KEY = new KeyMapping(
                "key.forgeaip.hud_toggle",
                InputConstants.Type.KEYSYM,
                GLFW.GLFW_KEY_F8,
                "key.categories.forgeaip"
        );
        MACRO_SCREEN_KEY = new KeyMapping(
                "key.forgeaip.macro_screen",
                InputConstants.Type.KEYSYM,
                GLFW.GLFW_KEY_F9,
                "key.categories.forgeaip"
        );
        LAUNCHER_SCREEN_KEY = new KeyMapping(
                "key.forgeaip.launcher_screen",
                InputConstants.Type.KEYSYM,
                GLFW.GLFW_KEY_F10,
                "key.categories.forgeaip"
        );
        event.register(HUD_TOGGLE_KEY);
        event.register(MACRO_SCREEN_KEY);
        event.register(LAUNCHER_SCREEN_KEY);
        AuxMod.LOGGER.info("[ForgeAIP] Key mappings registered (F8=HUD, F9=Macros, F10=Launcher).");
    }

    // -------------------------------------------------------------------------
    // Key input handling
    // -------------------------------------------------------------------------

    @SubscribeEvent
    public static void onKeyInput(InputEvent.Key event) {
        if (HUD_TOGGLE_KEY != null && HUD_TOGGLE_KEY.consumeClick()) {
            BotStatusHUD.toggleVisible();
            DebugOverlay.toggleOverlay();
            Minecraft mc = Minecraft.getInstance();
            if (mc.player != null) {
                mc.player.displayClientMessage(
                        net.minecraft.network.chat.Component.literal(
                                "[ForgeAIP] HUD " + (BotStatusHUD.isVisible() ? "enabled" : "disabled") +
                                " | Debug Overlay " + (DebugOverlay.isOverlayEnabled() ? "enabled" : "disabled")),
                        true);
            }
        }
        if (MACRO_SCREEN_KEY != null && MACRO_SCREEN_KEY.consumeClick()) {
            Minecraft mc = Minecraft.getInstance();
            if (mc.screen == null) {
                mc.setScreen(new MacroScreen());
            }
        }
        if (LAUNCHER_SCREEN_KEY != null && LAUNCHER_SCREEN_KEY.consumeClick()) {
            Minecraft mc = Minecraft.getInstance();
            if (mc.screen == null) {
                mc.setScreen(new LauncherScreen());
            }
        }
    }

    // -------------------------------------------------------------------------
    // Client tick — entity tracking
    // -------------------------------------------------------------------------

    @SubscribeEvent
    public static void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) return;
        if (!ForgeAIPConfig.CLIENT.entityTrackingEnabled.get()) return;

        entityTrackTick++;
        if (entityTrackTick < ENTITY_TRACK_INTERVAL) return;
        entityTrackTick = 0;

        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.level == null) return;
        if (!OrchestratorClient.getInstance().isConnected()) return;

        try {
            Vec3 playerPos = mc.player.position();
            String dimension = mc.level.dimension().location().toString();
            String playerName = mc.player.getName().getString();

            String body = String.format(
                "{\"playerName\":\"%s\",\"position\":{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f},\"dimension\":\"%s\"}",
                escapeJson(playerName),
                playerPos.x,
                playerPos.y,
                playerPos.z,
                escapeJson(dimension)
            );

            OrchestratorClient.getInstance().postJson("/api/entity_updates", body);
        } catch (Exception ex) {
            AuxMod.LOGGER.debug("[ForgeAIP] Entity tracking error: {}", ex.getMessage());
        }
    }

    // -------------------------------------------------------------------------
    // Chat-triggered immediate snapshot (fixes stale targetedBlock on "that chest")
    // -------------------------------------------------------------------------

    /**
     * Fires when the player submits a chat message (before the server receives it).
     * Captures the current crosshair target and sends an immediate entity-update so
     * the orchestrator has a fresh targetedBlock for the next LLM call.
     */
    @SubscribeEvent
    public static void onClientChat(net.minecraftforge.client.event.ClientChatEvent event) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.level == null) return;
        if (!OrchestratorClient.getInstance().isConnected()) return;

        try {
            Vec3 pp = mc.player.position();
            String playerName = mc.player.getName().getString();
            String dimension  = mc.level.dimension().location().toString();

            String body = String.format(
                "{\"playerName\":\"%s\",\"position\":{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f},\"dimension\":\"%s\"}",
                escapeJson(playerName), pp.x, pp.y, pp.z,
                escapeJson(dimension));

            OrchestratorClient.getInstance().postJson("/api/entity_updates", body);
        } catch (Exception ex) {
            AuxMod.LOGGER.debug("[ForgeAIP] Chat-triggered snapshot error: {}", ex.getMessage());
        }
    }

    // -------------------------------------------------------------------------
    // Login / logout lifecycle
    // -------------------------------------------------------------------------

    @SubscribeEvent
    public static void onPlayerLogin(ClientPlayerNetworkEvent.LoggingIn event) {
        AuxMod.LOGGER.info("[ForgeAIP] Player logged in — connecting to orchestrator.");
        OrchestratorClient.getInstance().connect();
    }

    @SubscribeEvent
    public static void onPlayerLogout(ClientPlayerNetworkEvent.LoggingOut event) {
        AuxMod.LOGGER.info("[ForgeAIP] Player logged out — disconnecting from orchestrator.");
        OrchestratorClient.getInstance().disconnect();
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }
}
