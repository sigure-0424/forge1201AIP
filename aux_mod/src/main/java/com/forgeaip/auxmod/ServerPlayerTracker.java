package com.forgeaip.auxmod;

import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

import java.io.File;
import java.io.FileWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * ServerPlayerTracker — writes all online player positions to
 * forgeaip_players.json every 2 seconds (40 ticks).
 *
 * This is the server-side counterpart to the client-side entity_updates system.
 * It ensures the Node.js bot always has fresh position data for every logged-in
 * player, regardless of whether they have the aux_mod installed on their client.
 *
 * Output format:
 * [{"name":"Seia_Y","x":-3.0,"y":127.0,"z":183.0,"dimension":"minecraft:overworld"},...]
 *
 * The Node.js bot reads this file every 2s and populates _externalPlayerPositions,
 * enabling the come/follow action to work at any distance.
 */
@Mod.EventBusSubscriber(modid = AuxMod.MOD_ID)
public class ServerPlayerTracker {

    private static final String OUTPUT_FILENAME = "forgeaip_players.json";
    private static final int WRITE_INTERVAL_TICKS = 40; // every 2 seconds
    private static int tickCounter = 0;

    @SubscribeEvent
    public static void onServerTick(TickEvent.ServerTickEvent event) {
        // Only run at END phase to ensure player list is stable
        if (event.phase != TickEvent.Phase.END) return;

        tickCounter++;
        if (tickCounter < WRITE_INTERVAL_TICKS) return;
        tickCounter = 0;

        // Collect all online player positions across all dimensions
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;

        for (ServerLevel level : event.getServer().getAllLevels()) {
            String dim = level.dimension().location().toString(); // e.g. "minecraft:overworld"
            List<ServerPlayer> players = level.players();

            for (ServerPlayer player : players) {
                // Skip the AI bot itself (username starts with AI_Bot)
                String name = player.getGameProfile().getName();
                if (name.startsWith("AI_Bot")) continue;

                double x = player.getX();
                double y = player.getY();
                double z = player.getZ();

                if (!first) sb.append(',');
                first = false;

                sb.append("{\"name\":\"").append(jsonEscape(name)).append('"');
                sb.append(",\"x\":").append(String.format("%.2f", x));
                sb.append(",\"y\":").append(String.format("%.2f", y));
                sb.append(",\"z\":").append(String.format("%.2f", z));
                sb.append(",\"dimension\":\"").append(jsonEscape(dim)).append("\"}");
            }
        }

        sb.append("]");

        // Write to file (best-effort; skip on error)
        try {
            File f = new File(OUTPUT_FILENAME);
            try (FileWriter fw = new FileWriter(f, StandardCharsets.UTF_8, false)) {
                fw.write(sb.toString());
            }
        } catch (Exception e) {
            // Non-critical — log only at debug level to avoid spam
            AuxMod.LOGGER.debug("[ServerPlayerTracker] Write failed: {}", e.getMessage());
        }
    }

    private static String jsonEscape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
