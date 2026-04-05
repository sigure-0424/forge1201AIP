package com.forgeaip.auxmod.client;

import com.forgeaip.auxmod.AuxMod;
import com.forgeaip.auxmod.ForgeAIPConfig;
import com.forgeaip.auxmod.network.OrchestratorClient;
import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.*;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.event.entity.player.PlayerEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import org.lwjgl.glfw.GLFW;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

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

            // Get targeted block
            HitResult hitResult = mc.player.pick(20.0D, 1.0F, false);
            Map<String, Object> targetedBlock = null;
            if (hitResult.getType() == HitResult.Type.BLOCK) {
                BlockHitResult blockHit = (BlockHitResult) hitResult;
                net.minecraft.core.BlockPos bPos = blockHit.getBlockPos();
                net.minecraft.world.level.block.state.BlockState state = mc.level.getBlockState(bPos);
                String blockType = net.minecraftforge.registries.ForgeRegistries.BLOCKS.getKey(state.getBlock()).toString();
                targetedBlock = new HashMap<>();
                targetedBlock.put("x", bPos.getX());
                targetedBlock.put("y", bPos.getY());
                targetedBlock.put("z", bPos.getZ());
                targetedBlock.put("type", blockType);
            }

            List<Map<String, Object>> players = new ArrayList<>();
            for (Player other : mc.level.players()) {
                if (other == null || other == mc.player || other.isRemoved()) continue;
                Map<String, Object> p = new HashMap<>();
                p.put("name", other.getGameProfile().getName());
                p.put("x", Math.round(other.getX() * 10.0) / 10.0);
                p.put("y", Math.round(other.getY() * 10.0) / 10.0);
                p.put("z", Math.round(other.getZ() * 10.0) / 10.0);
                players.add(p);
            }

            List<Map<String, Object>> entities = new ArrayList<>();
            for (Entity entity : mc.level.entitiesForRendering()) {
                if (entity == mc.player) continue;
                if (entity instanceof Player) continue;
                double dist = entity.distanceTo(mc.player);
                if (dist > 96) continue;

                Map<String, Object> e = new HashMap<>();
                e.put("type", entity.getType().getDescriptionId());
                e.put("name", entity.getName().getString());
                e.put("x", Math.round(entity.getX() * 10.0) / 10.0);
                e.put("y", Math.round(entity.getY() * 10.0) / 10.0);
                e.put("z", Math.round(entity.getZ() * 10.0) / 10.0);
                entities.add(e);
            }

            // Build JSON manually (no Gson dependency)
            StringBuilder sb = new StringBuilder();
            sb.append("{\"playerName\":\"").append(escapeJson(playerName)).append("\"");
            sb.append(",\"position\":{\"x\":").append(Math.round(playerPos.x * 10.0) / 10.0)
              .append(",\"y\":").append(Math.round(playerPos.y * 10.0) / 10.0)
              .append(",\"z\":").append(Math.round(playerPos.z * 10.0) / 10.0).append("}");
            sb.append(",\"dimension\":\"").append(escapeJson(dimension)).append("\"");

            if (targetedBlock != null) {
                sb.append(",\"targetedBlock\":{\"x\":").append(targetedBlock.get("x"))
                  .append(",\"y\":").append(targetedBlock.get("y"))
                  .append(",\"z\":").append(targetedBlock.get("z"))
                  .append(",\"type\":\"").append(escapeJson((String) targetedBlock.get("type"))).append("\"}");
            }

            sb.append(",\"nearbyEntities\":[");
            for (int i = 0; i < entities.size(); i++) {
                Map<String, Object> e = entities.get(i);
                if (i > 0) sb.append(",");
                sb.append("{\"type\":\"").append(escapeJson((String) e.get("type"))).append("\"");
                sb.append(",\"name\":\"").append(escapeJson((String) e.get("name"))).append("\"");
                sb.append(",\"x\":").append(e.get("x"));
                sb.append(",\"y\":").append(e.get("y"));
                sb.append(",\"z\":").append(e.get("z")).append("}");
            }
            sb.append("]");

            sb.append(",\"players\":[");
            for (int i = 0; i < players.size(); i++) {
                Map<String, Object> p = players.get(i);
                if (i > 0) sb.append(",");
                sb.append("{\"name\":\"").append(escapeJson((String) p.get("name"))).append("\"");
                sb.append(",\"x\":").append(p.get("x"));
                sb.append(",\"y\":").append(p.get("y"));
                sb.append(",\"z\":").append(p.get("z")).append("}");
            }
            sb.append("]}");

            OrchestratorClient.getInstance().postJson("/api/entity_updates", sb.toString());
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
        if (mc.hitResult == null || mc.hitResult.getType() != HitResult.Type.BLOCK) return;

        try {
            List<Map<String, Object>> players = new ArrayList<>();
            for (Player other : mc.level.players()) {
                if (other == null || other == mc.player || other.isRemoved()) continue;
                Map<String, Object> p = new HashMap<>();
                p.put("name", other.getGameProfile().getName());
                p.put("x", Math.round(other.getX() * 10.0) / 10.0);
                p.put("y", Math.round(other.getY() * 10.0) / 10.0);
                p.put("z", Math.round(other.getZ() * 10.0) / 10.0);
                players.add(p);
            }

            StringBuilder playersJson = new StringBuilder();
            playersJson.append("[");
            for (int i = 0; i < players.size(); i++) {
                Map<String, Object> p = players.get(i);
                if (i > 0) playersJson.append(",");
                playersJson.append("{\"name\":\"").append(escapeJson((String) p.get("name"))).append("\"");
                playersJson.append(",\"x\":").append(p.get("x"));
                playersJson.append(",\"y\":").append(p.get("y"));
                playersJson.append(",\"z\":").append(p.get("z")).append("}");
            }
            playersJson.append("]");

            BlockHitResult blockHit = (BlockHitResult) mc.hitResult;
            net.minecraft.core.BlockPos bPos = blockHit.getBlockPos();
            net.minecraft.world.level.block.state.BlockState state = mc.level.getBlockState(bPos);
            String blockType = net.minecraftforge.registries.ForgeRegistries.BLOCKS
                    .getKey(state.getBlock()).toString();

            Vec3 pp = mc.player.position();
            String playerName = mc.player.getName().getString();
            String dimension  = mc.level.dimension().location().toString();

            String body = String.format(
                "{\"playerName\":\"%s\",\"position\":{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f}," +
                "\"dimension\":\"%s\",\"targetedBlock\":{\"x\":%d,\"y\":%d,\"z\":%d,\"type\":\"%s\"}," +
                "\"nearbyEntities\":[],\"players\":%s}",
                escapeJson(playerName), pp.x, pp.y, pp.z,
                escapeJson(dimension),
                bPos.getX(), bPos.getY(), bPos.getZ(),
                escapeJson(blockType),
                playersJson);

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
