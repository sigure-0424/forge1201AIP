package com.forgeaip.auxmod;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.SlabType;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraftforge.event.server.ServerStartedEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.registries.ForgeRegistries;

import net.minecraft.world.entity.EntityType;
import net.minecraft.world.level.block.entity.SpawnerBlockEntity;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;

/**
 * Builds deterministic bot test zones on server startup using exported registry data.
 */
@Mod.EventBusSubscriber(modid = AuxMod.MOD_ID)
public class TestWorldGenerator {

    private static final String REGISTRY_FILENAME = "forgeaip_registry.json";
    private static final String MARKER_FILENAME = "forgeaip_testworld_generated.marker";
    private static final int ZONE_SPACING = 70;
    private static final int ZONE_HALF = 18;

    @SubscribeEvent
    public static void onServerStarted(ServerStartedEvent event) {
        try {
            ServerLevel level = event.getServer().overworld();
            if (level == null) return;

            File marker = level.getServer().getWorldPath(LevelResource.ROOT).resolve(MARKER_FILENAME).toFile();
            if (marker.exists()) {
                AuxMod.LOGGER.info("[TestWorldGenerator] Marker exists. Skip generation: {}", marker.getAbsolutePath());
                return;
            }

            List<String> solidModBlocks = loadSolidModBlocks();
            List<String> liquidModBlocks = loadLiquidModBlocks();
            Map<String, List<String>> byNamespace = groupByNamespace(solidModBlocks);

            BlockPos spawn = level.getSharedSpawnPos();
            int baseX = spawn.getX();
            int baseZ = spawn.getZ();
            int baseY = level.getHeight(Heightmap.Types.WORLD_SURFACE, baseX, baseZ) + 1;

            generateZone1Bridge(level, new BlockPos(baseX + ZONE_SPACING, baseY, baseZ), byNamespace);
            generateZone2Maze(level, new BlockPos(baseX + (ZONE_SPACING * 2), baseY, baseZ), solidModBlocks, liquidModBlocks);
            generateZone3BreakYard(level, new BlockPos(baseX + (ZONE_SPACING * 3), baseY, baseZ), solidModBlocks);

            generateZone4ItemRange(level, new BlockPos(baseX + ZONE_SPACING, baseY, baseZ + ZONE_SPACING), solidModBlocks);
            generateZone5MineAll(level, new BlockPos(baseX + (ZONE_SPACING * 2), baseY, baseZ + ZONE_SPACING));
            generateZone6CraftingHub(level, new BlockPos(baseX + (ZONE_SPACING * 3), baseY, baseZ + ZONE_SPACING));

            generateZone7DurabilityLane(level, new BlockPos(baseX + ZONE_SPACING, baseY, baseZ + (ZONE_SPACING * 2)));
            generateZone8JetpackHill(level, new BlockPos(baseX + (ZONE_SPACING * 2), baseY, baseZ + (ZONE_SPACING * 2)));
            generateZone9CombatArena(level, new BlockPos(baseX + (ZONE_SPACING * 3), baseY, baseZ + (ZONE_SPACING * 2)));

            Files.writeString(marker.toPath(), "generated", StandardCharsets.UTF_8);
            AuxMod.LOGGER.info("[TestWorldGenerator] Generated all zones around spawn ({}, {}, {}).", baseX, baseY, baseZ);
        } catch (Exception e) {
            AuxMod.LOGGER.error("[TestWorldGenerator] Failed to generate test zones: {}", e.getMessage());
        }
    }

    private static void generateZone1Bridge(ServerLevel level, BlockPos center, Map<String, List<String>> byNamespace) {
        clearZone(level, center, 28, 12);
        fill(level, center.offset(-24, -1, -2), center.offset(24, -1, 2), Blocks.STONE.defaultBlockState());

        int z = center.getZ();
        int startX = center.getX() - 22;
        int x = startX;

        for (Map.Entry<String, List<String>> entry : byNamespace.entrySet()) {
            int perNs = Math.min(10, entry.getValue().size());
            for (int i = 0; i < perNs && x < center.getX() + 22; i++) {
                BlockState state = resolveState(entry.getValue().get(i), true);
                level.setBlock(new BlockPos(x, center.getY(), z), state, 3);
                level.setBlock(new BlockPos(x, center.getY(), z - 1), state, 3);
                x++;
            }
            if (x < center.getX() + 22) x++;
        }
    }

    private static void generateZone2Maze(ServerLevel level, BlockPos center, List<String> solidModBlocks, List<String> liquidModBlocks) {
        clearZone(level, center, 26, 10);
        int size = 21;
        int half = size / 2;
        Random random = new Random(2026040902L);

        fill(level,
                center.offset(-half, -1, -half),
                center.offset(half, -1, half),
                Blocks.SMOOTH_STONE.defaultBlockState());

        for (int z = -half; z <= half; z++) {
            for (int x = -half; x <= half; x++) {
                boolean boundary = Math.abs(x) == half || Math.abs(z) == half;
                boolean checker = (x % 2 == 0 && z % 2 == 0);
                if (!boundary && !checker) continue;
                if (x == -half + 1 || z == half - 1) continue;

                BlockState wall = resolveState(pickRandom(solidModBlocks, random), false);
                BlockPos b = center.offset(x, 0, z);
                level.setBlock(b, wall, 3);
                level.setBlock(b.above(), wall, 3);
                level.setBlock(b.above(2), wall, 3);
            }
        }

        BlockState fluid = resolveFluidOrFallback(liquidModBlocks, random);
        level.setBlock(center.offset(4, 0, 4), fluid, 3);
        level.setBlock(center.offset(-5, 0, -6), fluid, 3);
    }

    private static void generateZone3BreakYard(ServerLevel level, BlockPos center, List<String> solidModBlocks) {
        clearZone(level, center, 22, 10);
        fill(level, center.offset(-16, -1, -16), center.offset(16, -1, 16), Blocks.STONE.defaultBlockState());

        Random random = new Random(2026040903L);
        for (int x = -12; x <= 12; x += 3) {
            for (int z = -12; z <= 12; z += 3) {
                BlockState b = resolveState(pickRandom(solidModBlocks, random), false);
                level.setBlock(center.offset(x, 0, z), b, 3);
                level.setBlock(center.offset(x, 1, z), b, 3);
            }
        }

        level.setBlock(center.offset(-14, 0, 0), Blocks.CHEST.defaultBlockState(), 3);
        level.setBlock(center.offset(-14, 0, 2), Blocks.FURNACE.defaultBlockState(), 3);
    }

    private static void generateZone4ItemRange(ServerLevel level, BlockPos center, List<String> solidModBlocks) {
        clearZone(level, center, 22, 10);
        fill(level, center.offset(-18, -1, -8), center.offset(18, -1, 8), Blocks.STONE.defaultBlockState());

        Random random = new Random(2026040904L);
        for (int x = -10; x <= 10; x++) {
            BlockState target = resolveState(pickRandom(solidModBlocks, random), false);
            level.setBlock(center.offset(x, 0, 6), target, 3);
            level.setBlock(center.offset(x, 1, 6), target, 3);
        }

        level.setBlock(center.offset(0, 0, -6), Blocks.CRAFTING_TABLE.defaultBlockState(), 3);
    }

    private static void generateZone5MineAll(ServerLevel level, BlockPos center) {
        clearZone(level, center, 20, 10);
        fill(level, center.offset(-16, -1, -16), center.offset(16, -1, 16), Blocks.STONE.defaultBlockState());

        for (int x = -9; x <= 9; x += 3) {
            for (int z = -9; z <= 9; z += 3) {
                for (int y = 0; y < 4; y++) {
                    level.setBlock(center.offset(x, y, z), Blocks.OAK_LOG.defaultBlockState(), 3);
                }
            }
        }

        for (int x = -6; x <= 6; x++) {
            level.setBlock(center.offset(x, 0, 12), Blocks.STONE.defaultBlockState(), 3);
            level.setBlock(center.offset(x, 1, 12), Blocks.STONE.defaultBlockState(), 3);
        }
    }

    private static void generateZone6CraftingHub(ServerLevel level, BlockPos center) {
        clearZone(level, center, 16, 8);
        fill(level, center.offset(-10, -1, -10), center.offset(10, -1, 10), Blocks.SMOOTH_STONE.defaultBlockState());

        level.setBlock(center.offset(0, 0, 0), Blocks.CRAFTING_TABLE.defaultBlockState(), 3);
        level.setBlock(center.offset(2, 0, 0), Blocks.FURNACE.defaultBlockState(), 3);
        level.setBlock(center.offset(4, 0, 0), Blocks.BLAST_FURNACE.defaultBlockState(), 3);
        level.setBlock(center.offset(-2, 0, 0), Blocks.CHEST.defaultBlockState(), 3);
        level.setBlock(center.offset(-4, 0, 0), Blocks.CHEST.defaultBlockState(), 3);
    }

    private static void generateZone7DurabilityLane(ServerLevel level, BlockPos center) {
        clearZone(level, center, 20, 8);
        fill(level, center.offset(-16, -1, -4), center.offset(16, -1, 4), Blocks.STONE.defaultBlockState());
        for (int x = -14; x <= 14; x++) {
            level.setBlock(center.offset(x, 0, 0), Blocks.STONE.defaultBlockState(), 3);
            if (x % 3 == 0) {
                level.setBlock(center.offset(x, 1, 0), Blocks.COBBLESTONE.defaultBlockState(), 3);
            }
        }
    }

    private static void generateZone8JetpackHill(ServerLevel level, BlockPos center) {
        clearZone(level, center, 24, 30);
        fill(level, center.offset(-20, -1, -20), center.offset(20, -1, 20), Blocks.STONE.defaultBlockState());

        for (int r = 12; r >= 1; r--) {
            int y = 12 - r;
            for (int x = -r; x <= r; x++) {
                for (int z = -r; z <= r; z++) {
                    if (Math.abs(x) + Math.abs(z) <= r + 2) {
                        level.setBlock(center.offset(x, y, z), Blocks.STONE.defaultBlockState(), 3);
                    }
                }
            }
        }
    }

    private static void generateZone9CombatArena(ServerLevel level, BlockPos center) {
        clearZone(level, center, 24, 12);
        fill(level, center.offset(-18, -1, -18), center.offset(18, -1, 18), Blocks.STONE.defaultBlockState());

        for (int x = -18; x <= 18; x++) {
            level.setBlock(center.offset(x, 0, -18), Blocks.OBSIDIAN.defaultBlockState(), 3);
            level.setBlock(center.offset(x, 0, 18), Blocks.OBSIDIAN.defaultBlockState(), 3);
        }
        for (int z = -18; z <= 18; z++) {
            level.setBlock(center.offset(-18, 0, z), Blocks.OBSIDIAN.defaultBlockState(), 3);
            level.setBlock(center.offset(18, 0, z), Blocks.OBSIDIAN.defaultBlockState(), 3);
        }

        // Place zombie spawner at the center of the arena for combat testing
        BlockPos spawnerPos = center.offset(0, 0, 0);
        level.setBlock(spawnerPos, Blocks.SPAWNER.defaultBlockState(), 3);
        SpawnerBlockEntity spawnerBE = (SpawnerBlockEntity) level.getBlockEntity(spawnerPos);
        if (spawnerBE != null) {
            spawnerBE.getSpawner().setEntityId(EntityType.ZOMBIE, level, level.getRandom(), spawnerPos);
        }
    }

    private static void clearZone(ServerLevel level, BlockPos center, int halfWidth, int maxHeight) {
        fill(level,
                center.offset(-halfWidth, 0, -halfWidth),
                center.offset(halfWidth, maxHeight, halfWidth),
                Blocks.AIR.defaultBlockState());
    }

    private static void fill(ServerLevel level, BlockPos from, BlockPos to, BlockState state) {
        int minX = Math.min(from.getX(), to.getX());
        int minY = Math.min(from.getY(), to.getY());
        int minZ = Math.min(from.getZ(), to.getZ());
        int maxX = Math.max(from.getX(), to.getX());
        int maxY = Math.max(from.getY(), to.getY());
        int maxZ = Math.max(from.getZ(), to.getZ());

        for (int x = minX; x <= maxX; x++) {
            for (int y = minY; y <= maxY; y++) {
                for (int z = minZ; z <= maxZ; z++) {
                    level.setBlock(new BlockPos(x, y, z), state, 3);
                }
            }
        }
    }

    private static List<String> loadSolidModBlocks() {
        List<String> out = new ArrayList<>();
        File f = new File(REGISTRY_FILENAME);
        if (!f.exists()) return out;

        try {
            String raw = Files.readString(f.toPath(), StandardCharsets.UTF_8);
            JsonObject root = JsonParser.parseString(raw).getAsJsonObject();
            JsonArray blocks = root.getAsJsonArray("blocks");
            if (blocks == null) return out;

            for (JsonElement el : blocks) {
                JsonObject o = el.getAsJsonObject();
                String name = o.has("name") ? o.get("name").getAsString() : "";
                boolean isAir = o.has("isAir") && o.get("isAir").getAsBoolean();
                boolean isLiquid = o.has("isLiquid") && o.get("isLiquid").getAsBoolean();
                if (name.isEmpty() || isAir || isLiquid || !isSafeTestBlockName(name)) continue;
                out.add(name);
            }
        } catch (Exception e) {
            AuxMod.LOGGER.warn("[TestWorldGenerator] Failed to read solid blocks from registry: {}", e.getMessage());
        }
        return out;
    }

    private static List<String> loadLiquidModBlocks() {
        List<String> out = new ArrayList<>();
        File f = new File(REGISTRY_FILENAME);
        if (!f.exists()) return out;

        try {
            String raw = Files.readString(f.toPath(), StandardCharsets.UTF_8);
            JsonObject root = JsonParser.parseString(raw).getAsJsonObject();
            JsonArray blocks = root.getAsJsonArray("blocks");
            if (blocks == null) return out;

            for (JsonElement el : blocks) {
                JsonObject o = el.getAsJsonObject();
                String name = o.has("name") ? o.get("name").getAsString() : "";
                boolean isLiquid = o.has("isLiquid") && o.get("isLiquid").getAsBoolean();
                if (name.isEmpty() || !isLiquid || !isSafeTestBlockName(name)) continue;
                out.add(name);
            }
        } catch (Exception e) {
            AuxMod.LOGGER.warn("[TestWorldGenerator] Failed to read liquid blocks from registry: {}", e.getMessage());
        }
        return out;
    }

    private static Map<String, List<String>> groupByNamespace(List<String> solidBlocks) {
        if (solidBlocks.isEmpty()) return Collections.emptyMap();
        Map<String, List<String>> map = new HashMap<>();
        for (String name : solidBlocks) {
            String[] parts = name.split(":", 2);
            if (parts.length != 2) continue;
            map.computeIfAbsent(parts[0], k -> new ArrayList<>()).add(name);
        }

        Map<String, List<String>> sorted = new LinkedHashMap<>();
        map.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .forEach(e -> sorted.put(e.getKey(), e.getValue()));
        return sorted;
    }

    private static String pickRandom(List<String> list, Random random) {
        if (list == null || list.isEmpty()) return "minecraft:stone";
        return list.get(random.nextInt(list.size()));
    }

    private static boolean isSafeTestBlockName(String blockName) {
        String n = blockName.toLowerCase(Locale.ROOT);
        if (n.contains("copycat")) return false;
        if (n.contains("controller")) return false;
        if (n.contains("lectern")) return false;
        if (n.contains("spawner")) return false;
        if (n.contains("portal")) return false;
        if (n.contains("command_block")) return false;
        return true;
    }

    private static BlockState resolveState(String blockName, boolean preferSlabBottom) {
        if (blockName == null || blockName.isEmpty()) return Blocks.STONE.defaultBlockState();
        try {
            ResourceLocation rl = new ResourceLocation(blockName.toLowerCase(Locale.ROOT));
            Block block = ForgeRegistries.BLOCKS.getValue(rl);
            if (block == null || block == Blocks.AIR) return Blocks.STONE.defaultBlockState();

            BlockState state = block.defaultBlockState();
            if (state.hasBlockEntity()) return Blocks.STONE.defaultBlockState();
            if (preferSlabBottom && block instanceof SlabBlock && state.hasProperty(BlockStateProperties.SLAB_TYPE)) {
                return state.setValue(BlockStateProperties.SLAB_TYPE, SlabType.BOTTOM);
            }
            return state;
        } catch (Exception e) {
            return Blocks.STONE.defaultBlockState();
        }
    }

    private static BlockState resolveFluidOrFallback(List<String> liquidModBlocks, Random random) {
        String modFluidName = pickRandom(liquidModBlocks, random);
        BlockState state = resolveState(modFluidName, false);
        if (state.getBlock() == Blocks.STONE) {
            return Blocks.WATER.defaultBlockState();
        }
        return state;
    }
}
