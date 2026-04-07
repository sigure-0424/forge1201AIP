package com.forgeaip.auxmod;

import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraftforge.event.server.ServerStartedEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.ForgeRegistry;
import net.minecraftforge.registries.GameData;

import java.io.File;
import java.io.FileWriter;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;

/**
 * BlockRegistryExporter — exports the Forge-remapped block state IDs and item IDs
 * to the Node.js orchestrator at server startup.
 *
 * This provides authoritative mapping data instead of relying on heuristic
 * binary scanning of FML3 handshake buffers. The Node.js DynamicRegistryInjector
 * uses this data to correctly resolve modded block/item names from numeric IDs,
 * fixing issues like modded items (jetpacks, etc.) appearing as "unknown".
 *
 * Only non-vanilla (non-minecraft:) entries are exported since vanilla mappings
 * are already known to mineflayer via minecraft-data.
 */
@Mod.EventBusSubscriber(modid = AuxMod.MOD_ID)
public class BlockRegistryExporter {

    /**
     * Output file path.  The server's working directory is E:\forge1201server\, so this
     * writes to E:\forge1201server\forgeaip_registry.json.  The Node.js bot reads this
     * path via the MC_SERVER_DIR env variable (or falls back to data/server_registry.json).
     *
     * File-based delivery is simpler and more reliable than HTTP: it avoids firewall rules,
     * Content-Type negotiation, body-size limits, and method-matching issues.
     */
    private static final String OUTPUT_FILENAME = "forgeaip_registry.json";

    @SubscribeEvent
    public static void onServerStarted(ServerStartedEvent event) {
        // Build and write on a daemon thread so the server tick thread is never blocked.
        ExecutorService scheduler = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "ForgeAIP-RegistryExport");
            t.setDaemon(true);
            return t;
        });

        scheduler.submit(() -> {
            try {
                String json = buildRegistryJson();
                File outFile = new File(OUTPUT_FILENAME);
                try (FileWriter fw = new FileWriter(outFile, StandardCharsets.UTF_8, false)) {
                    fw.write(json);
                }
                AuxMod.LOGGER.info("[BlockRegistryExporter] Registry written to {} ({} chars).",
                        outFile.getAbsolutePath(), json.length());
            } catch (Exception e) {
                AuxMod.LOGGER.error("[BlockRegistryExporter] Failed to write registry: {}", e.getMessage());
            } finally {
                scheduler.shutdown();
            }
        });

    }

    /**
     * Build the registry JSON containing:
     * - blocks: non-vanilla blocks with their Forge-remapped state ID ranges
     * - items:  non-vanilla items with their Forge-remapped numeric IDs
     */
    private static String buildRegistryJson() {
        // Retrieve Forge's authoritative block-state ID map (wire IDs).
        var blockStateMap = GameData.getBlockStateIDMap();

        StringBuilder sb = new StringBuilder(1024 * 512); // ~512 KB pre-alloc
        sb.append("{\"blocks\":[");

        boolean firstBlock = true;
        for (Map.Entry<ResourceLocation, Block> entry :
                ForgeRegistries.BLOCKS.getEntries().stream()
                        .map(e -> Map.entry(e.getKey().location(), e.getValue()))
                        .toList()) {

            ResourceLocation rl = entry.getKey();
            // Skip vanilla — mineflayer already knows minecraft: namespace.
            if ("minecraft".equals(rl.getNamespace())) continue;

            Block block = entry.getValue();
            boolean isLiquid = block instanceof LiquidBlock;
            boolean isAir = block.defaultBlockState().isAir();

            // Collect state IDs for this block.
            int minStateId = Integer.MAX_VALUE;
            int maxStateId = Integer.MIN_VALUE;
            int defaultStateId = blockStateMap.getId(block.defaultBlockState());

            for (BlockState state : block.getStateDefinition().getPossibleStates()) {
                int sid = blockStateMap.getId(state);
                if (sid < 0) continue; // unmapped state — skip
                if (sid < minStateId) minStateId = sid;
                if (sid > maxStateId) maxStateId = sid;
            }

            if (minStateId == Integer.MAX_VALUE) continue; // no valid states found

            if (!firstBlock) sb.append(',');
            firstBlock = false;

            sb.append("{\"name\":\"").append(rl).append('"');
            sb.append(",\"defaultStateId\":").append(defaultStateId);
            sb.append(",\"minStateId\":").append(minStateId);
            sb.append(",\"maxStateId\":").append(maxStateId);
            sb.append(",\"isAir\":").append(isAir);
            sb.append(",\"isLiquid\":").append(isLiquid);
            // hasCollision: use the default state's collision flag.
            // Accessing collision shapes requires a level; use the simpler
            // block property instead (correct for the vast majority of blocks).
            sb.append(",\"hasCollision\":").append(!isAir && !isLiquid);
            sb.append('}');
        }

        sb.append("],\"items\":[");

        boolean firstItem = true;
        for (Map.Entry<ResourceLocation, Item> entry :
                ForgeRegistries.ITEMS.getEntries().stream()
                        .map(e -> Map.entry(e.getKey().location(), e.getValue()))
                        .toList()) {

            ResourceLocation rl = entry.getKey();
            if ("minecraft".equals(rl.getNamespace())) continue;

            Item item = entry.getValue();
            int itemId = ((ForgeRegistry<Item>) ForgeRegistries.ITEMS).getID(item);
            if (itemId < 0) continue;

            if (!firstItem) sb.append(',');
            firstItem = false;

            sb.append("{\"name\":\"").append(rl).append('"');
            sb.append(",\"id\":").append(itemId);
            sb.append(",\"maxStackSize\":").append(item.getMaxStackSize());
            sb.append('}');
        }

        sb.append("]}");
        return sb.toString();
    }
}
