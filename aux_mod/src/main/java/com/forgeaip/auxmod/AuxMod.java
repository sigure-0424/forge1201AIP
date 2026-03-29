package com.forgeaip.auxmod;

import com.forgeaip.auxmod.data.MacroManager;
import com.forgeaip.auxmod.data.SafeZoneManager;
import com.forgeaip.auxmod.network.OrchestratorClient;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.fml.ModLoadingContext;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.config.ModConfig;
import net.minecraftforge.fml.event.lifecycle.FMLClientSetupEvent;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

@Mod(AuxMod.MOD_ID)
public class AuxMod {

    public static final String MOD_ID = "forgeaip";
    public static final Logger LOGGER = LogManager.getLogger(MOD_ID);

    public AuxMod() {
        // Register the Forge config
        ModLoadingContext.get().registerConfig(ModConfig.Type.CLIENT, ForgeAIPConfig.CLIENT_SPEC, "forgeaip-client.toml");

        // Register mod setup events
        FMLJavaModLoadingContext.get().getModEventBus().addListener(this::clientSetup);

        // Register client event handlers via EventBusSubscriber annotation in ClientEvents
        MinecraftForge.EVENT_BUS.register(this);

        LOGGER.info("[ForgeAIP] AuxMod initializing...");
    }

    private void clientSetup(final FMLClientSetupEvent event) {
        LOGGER.info("[ForgeAIP] Client setup starting...");

        // Initialize managers
        SafeZoneManager.getInstance().load();
        MacroManager.getInstance().load();

        LOGGER.info("[ForgeAIP] Client setup complete.");
    }
}
