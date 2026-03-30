package com.forgeaip.auxmod.command;

import com.forgeaip.auxmod.AuxMod;
import com.forgeaip.auxmod.data.SafeZoneManager;
import com.forgeaip.auxmod.network.OrchestratorClient;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.DoubleArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.minecraft.client.Minecraft;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.world.phys.Vec3;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.RegisterClientCommandsEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

import java.util.Collection;

/**
 * Client-side commands for safe zone management.
 *
 * <pre>
 *   /safezone add &lt;name&gt;                                -- registers the 16x16 chunk the player is in
 *   /safezone addbox &lt;name&gt; x1 y1 z1 x2 y2 z2        -- exact bounding box
 *   /safezone remove &lt;name&gt;                            -- removes a zone
 *   /safezone list                                      -- lists all zones
 * </pre>
 */
@Mod.EventBusSubscriber(modid = AuxMod.MOD_ID, value = Dist.CLIENT, bus = Mod.EventBusSubscriber.Bus.FORGE)
public class SafeZoneCommand {

    @SubscribeEvent
    public static void onRegisterClientCommands(RegisterClientCommandsEvent event) {
        CommandDispatcher<CommandSourceStack> dispatcher = event.getDispatcher();

        dispatcher.register(
            net.minecraft.commands.Commands.literal("safezone")

                // /safezone add <name>
                .then(net.minecraft.commands.Commands.literal("add")
                    .then(net.minecraft.commands.Commands.argument("name", StringArgumentType.word())
                        .executes(ctx -> {
                            cmdAddChunk(StringArgumentType.getString(ctx, "name"));
                            return 1;
                        })))

                // /safezone addbox <name> x1 y1 z1 x2 y2 z2
                .then(net.minecraft.commands.Commands.literal("addbox")
                    .then(net.minecraft.commands.Commands.argument("name", StringArgumentType.word())
                        .then(net.minecraft.commands.Commands.argument("x1", DoubleArgumentType.doubleArg())
                        .then(net.minecraft.commands.Commands.argument("y1", DoubleArgumentType.doubleArg())
                        .then(net.minecraft.commands.Commands.argument("z1", DoubleArgumentType.doubleArg())
                        .then(net.minecraft.commands.Commands.argument("x2", DoubleArgumentType.doubleArg())
                        .then(net.minecraft.commands.Commands.argument("y2", DoubleArgumentType.doubleArg())
                        .then(net.minecraft.commands.Commands.argument("z2", DoubleArgumentType.doubleArg())
                            .executes(ctx -> {
                                cmdAddBox(
                                    StringArgumentType.getString(ctx, "name"),
                                    DoubleArgumentType.getDouble(ctx, "x1"),
                                    DoubleArgumentType.getDouble(ctx, "y1"),
                                    DoubleArgumentType.getDouble(ctx, "z1"),
                                    DoubleArgumentType.getDouble(ctx, "x2"),
                                    DoubleArgumentType.getDouble(ctx, "y2"),
                                    DoubleArgumentType.getDouble(ctx, "z2")
                                );
                                return 1;
                            }))))))))

                // /safezone remove <name>
                .then(net.minecraft.commands.Commands.literal("remove")
                    .then(net.minecraft.commands.Commands.argument("name", StringArgumentType.word())
                        .executes(ctx -> {
                            cmdRemove(StringArgumentType.getString(ctx, "name"));
                            return 1;
                        })))

                // /safezone list
                .then(net.minecraft.commands.Commands.literal("list")
                    .executes(ctx -> {
                        cmdList();
                        return 1;
                    }))
        );
        AuxMod.LOGGER.info("[ForgeAIP] /safezone command registered.");
    }

    // -------------------------------------------------------------------------
    // Command implementations
    // -------------------------------------------------------------------------

    private static void cmdAddChunk(String name) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.level == null) return;

        Vec3 pos = mc.player.position();
        String dim = mc.level.dimension().location().toString();
        // Register the 16×256×16 chunk column the player is currently standing in
        int cx = (int) Math.floor(pos.x / 16) * 16;
        int cz = (int) Math.floor(pos.z / 16) * 16;

        SafeZoneManager.SafeZone zone = SafeZoneManager.SafeZone.fromChunk(name, cx / 16, cz / 16, dim);
        SafeZoneManager.getInstance().addZone(zone);
        syncAdd(zone);

        mc.player.displayClientMessage(
                Component.literal("[ForgeAIP] Safe zone '" + name + "' added at chunk (" + cx + "," + cz + ")."), false);
    }

    private static void cmdAddBox(String name, double x1, double y1, double z1,
                                   double x2, double y2, double z2) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.level == null) return;

        String dim = mc.level.dimension().location().toString();
        SafeZoneManager.SafeZone zone = new SafeZoneManager.SafeZone(name, x1, y1, z1, x2, y2, z2, dim);
        SafeZoneManager.getInstance().addZone(zone);
        syncAdd(zone);

        mc.player.displayClientMessage(
                Component.literal("[ForgeAIP] Safe zone '" + name + "' added."), false);
    }

    private static void cmdRemove(String name) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return;

        boolean removed = SafeZoneManager.getInstance().removeZone(name);
        if (removed) {
            OrchestratorClient.getInstance().deleteJson("/api/safezones/" + name);
            mc.player.displayClientMessage(
                    Component.literal("[ForgeAIP] Safe zone '" + name + "' removed."), false);
        } else {
            mc.player.displayClientMessage(
                    Component.literal("[ForgeAIP] No safe zone named '" + name + "'."), false);
        }
    }

    private static void cmdList() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return;

        Collection<SafeZoneManager.SafeZone> zones = SafeZoneManager.getInstance().getAllZones();
        if (zones.isEmpty()) {
            mc.player.displayClientMessage(Component.literal("[ForgeAIP] No safe zones registered."), false);
            return;
        }
        mc.player.displayClientMessage(Component.literal("[ForgeAIP] Safe zones (" + zones.size() + "):"), false);
        for (SafeZoneManager.SafeZone z : zones) {
            String dimStr = z.dimension != null ? " [" + z.dimension + "]" : "";
            String line = String.format("  %s: (%.0f,%.0f,%.0f)-(%.0f,%.0f,%.0f)%s",
                    z.name, z.x1, z.y1, z.z1, z.x2, z.y2, z.z2, dimStr);
            mc.player.displayClientMessage(Component.literal(line), false);
        }
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    private static void syncAdd(SafeZoneManager.SafeZone zone) {
        String dimPart = zone.dimension != null ? ",\"dimension\":\"" + escape(zone.dimension) + "\"" : "";
        String body = String.format(
                "{\"name\":\"%s\",\"minX\":%s,\"minY\":%s,\"minZ\":%s," +
                "\"maxX\":%s,\"maxY\":%s,\"maxZ\":%s%s}",
                escape(zone.name),
                zone.x1, zone.y1, zone.z1,
                zone.x2, zone.y2, zone.z2,
                dimPart);
        OrchestratorClient.getInstance().postJson("/api/safezones", body);
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
