package com.forgeaip.auxmod.command;

import com.forgeaip.auxmod.AuxMod;
import com.forgeaip.auxmod.data.BotStatus;
import com.forgeaip.auxmod.network.OrchestratorClient;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.minecraft.client.Minecraft;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.RegisterClientCommandsEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Client-side Brigadier commands for in-game bot management.
 *
 * <pre>
 *   /bot list                        -- list all bots and their status
 *   /bot start &lt;name&gt;               -- POST /api/bots  (starts a bot)
 *   /bot stop &lt;name&gt;                -- DELETE /api/bots/:name
 *   /bot chat &lt;name&gt; &lt;message&gt;     -- POST /api/bots/:name/chat
 * </pre>
 */
@Mod.EventBusSubscriber(modid = AuxMod.MOD_ID, value = Dist.CLIENT, bus = Mod.EventBusSubscriber.Bus.FORGE)
public class BotCommand {

    @SubscribeEvent
    public static void onRegisterClientCommands(RegisterClientCommandsEvent event) {
        CommandDispatcher<CommandSourceStack> dispatcher = event.getDispatcher();

        dispatcher.register(
            net.minecraft.commands.Commands.literal("bot")

                // /bot list
                .then(net.minecraft.commands.Commands.literal("list")
                    .executes(ctx -> {
                        cmdList();
                        return 1;
                    }))

                // /bot start <name>
                .then(net.minecraft.commands.Commands.literal("start")
                    .then(net.minecraft.commands.Commands.argument("name", StringArgumentType.word())
                        .executes(ctx -> {
                            String name = StringArgumentType.getString(ctx, "name");
                            cmdStart(name);
                            return 1;
                        })))

                // /bot stop <name>
                .then(net.minecraft.commands.Commands.literal("stop")
                    .then(net.minecraft.commands.Commands.argument("name", StringArgumentType.word())
                        .executes(ctx -> {
                            String name = StringArgumentType.getString(ctx, "name");
                            cmdStop(name);
                            return 1;
                        })))

                // /bot chat <name> <message>
                .then(net.minecraft.commands.Commands.literal("chat")
                    .then(net.minecraft.commands.Commands.argument("name", StringArgumentType.word())
                        .then(net.minecraft.commands.Commands.argument("message", StringArgumentType.greedyString())
                            .executes(ctx -> {
                                String name = StringArgumentType.getString(ctx, "name");
                                String msg  = StringArgumentType.getString(ctx, "message");
                                cmdChat(name, msg);
                                return 1;
                            }))))
        );
        AuxMod.LOGGER.info("[ForgeAIP] /bot command registered.");
    }

    // -------------------------------------------------------------------------
    // Command implementations
    // -------------------------------------------------------------------------

    private static void cmdList() {
        Map<String, BotStatus> statuses = OrchestratorClient.getInstance().botStatuses;
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return;

        if (statuses.isEmpty()) {
            mc.player.displayClientMessage(
                    Component.literal("[ForgeAIP] No bots connected (or orchestrator offline)."), false);
            return;
        }
        mc.player.displayClientMessage(
                Component.literal("[ForgeAIP] Bots (" + statuses.size() + "):"), false);
        for (Map.Entry<String, BotStatus> e : statuses.entrySet()) {
            BotStatus s = e.getValue();
            String line = String.format("  %s | hp=%.0f food=%.0f (%.0f,%.0f,%.0f) %s",
                    e.getKey(), s.health, s.food, s.x, s.y, s.z,
                    s.isExecuting ? "[" + s.getCurrentAction() + "]" : "idle");
            mc.player.displayClientMessage(Component.literal(line), false);
        }
    }

    private static void cmdStart(String name) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return;
        mc.player.displayClientMessage(
                Component.literal("[ForgeAIP] Starting bot: " + name + "..."), false);

        String body = "{\"name\":\"" + escape(name) + "\"}";
        OrchestratorClient.getInstance().postJson("/api/bots", body)
                .thenAccept(resp -> {
                    String msg = resp != null && resp.contains("\"ok\":true")
                            ? "[ForgeAIP] Bot " + name + " started."
                            : "[ForgeAIP] Failed to start " + name + ": " + resp;
                    sendClientMessage(msg);
                });
    }

    private static void cmdStop(String name) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return;
        mc.player.displayClientMessage(
                Component.literal("[ForgeAIP] Stopping bot: " + name + "..."), false);

        OrchestratorClient.getInstance().deleteJson("/api/bots/" + name)
                .thenAccept(resp -> {
                    String msg = resp != null && (resp.contains("\"ok\":true") || resp.contains("200"))
                            ? "[ForgeAIP] Bot " + name + " stopped."
                            : "[ForgeAIP] Failed to stop " + name + ": " + resp;
                    sendClientMessage(msg);
                });
    }

    private static void cmdChat(String name, String message) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return;
        mc.player.displayClientMessage(
                Component.literal("[ForgeAIP] Sending to " + name + ": " + message), false);

        // Capture crosshair target at command time so orchestrator has a fresh targetedBlock.
        if (mc.level != null && mc.hitResult != null && mc.hitResult.getType() == HitResult.Type.BLOCK) {
            try {
                BlockHitResult blockHit = (BlockHitResult) mc.hitResult;
                BlockPos bPos = blockHit.getBlockPos();
                BlockState state = mc.level.getBlockState(bPos);
                String blockType = net.minecraftforge.registries.ForgeRegistries.BLOCKS
                        .getKey(state.getBlock()).toString();
                Vec3 pp = mc.player.position();
                String playerName = mc.player.getName().getString();
                String dimension  = mc.level.dimension().location().toString();
                String snapshot = String.format(
                    "{\"playerName\":\"%s\",\"position\":{\"x\":%.1f,\"y\":%.1f,\"z\":%.1f}," +
                    "\"dimension\":\"%s\",\"targetedBlock\":{\"x\":%d,\"y\":%d,\"z\":%d,\"type\":\"%s\"}," +
                    "\"nearbyEntities\":[]}",
                    escape(playerName), pp.x, pp.y, pp.z,
                    escape(dimension),
                    bPos.getX(), bPos.getY(), bPos.getZ(),
                    escape(blockType));
                OrchestratorClient.getInstance().postJson("/api/entity_updates", snapshot);
            } catch (Exception ex) {
                AuxMod.LOGGER.debug("[ForgeAIP] cmdChat snapshot error: {}", ex.getMessage());
            }
        }

        String senderName = mc.player.getName().getString();
        String body = "{\"username\":\"" + escape(senderName) + "\",\"message\":\"" + escape(message) + "\"}";
        OrchestratorClient.getInstance().postJson("/api/bots/" + name + "/chat", body)
                .thenAccept(resp -> {
                    String msg = resp != null && !resp.isBlank()
                            ? "[ForgeAIP] Sent."
                            : "[ForgeAIP] Failed to send to " + name;
                    sendClientMessage(msg);
                });
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    private static void sendClientMessage(String text) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player != null) {
            // Must run on the render thread
            mc.execute(() -> mc.player.displayClientMessage(Component.literal(text), false));
        }
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
