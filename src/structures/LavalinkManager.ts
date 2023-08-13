import { EventEmitter } from "events";
import { NodeManager } from "./NodeManager";
import { DefaultQueueStore, Queue, QueueChangesWatcher, QueueSaverOptions, StoreManager } from "./Queue";
import { GuildShardPayload, LavalinkSearchPlatform, ManagerUitls, MiniMap, SearchPlatform, TrackEndEvent, TrackExceptionEvent, TrackStartEvent, TrackStuckEvent, VoicePacket, VoiceServer, VoiceState, WebSocketClosedEvent } from "./Utils";
import { LavalinkNodeOptions } from "./Node";
import { DefaultSources, SourceLinksRegexes } from "./LavalinkManagerStatics";
import { DestroyReasons, DestroyReasonsType, Player, PlayerOptions } from "./Player";
import { Track } from "./Track";

export interface LavalinkManager {
  nodeManager: NodeManager;
  utils: ManagerUitls;
}

export interface BotClientOptions {
  shards?: number | number[] | "auto";
  id: string;
  username?: string;
  /** So users can pass entire objects / classes */
  [x: string | number | symbol | undefined]: any;
}

export interface LavalinkPlayerOptions {
  /** If the Lavalink Volume should be decremented by x number */
  volumeDecrementer?: number;
  /** How often it should update the the player Position */
  clientBasedPositionUpdateInterval?: number;
  /** What should be used as a searchPlatform, if no source was provided during the query */
  defaultSearchPlatform?: SearchPlatform;
  /** Applies the volume via a filter, not via the lavalink volume transformer */
  applyVolumeAsFilter?:boolean;
  /** Transforms the saved data of a requested user */
  requesterTransformer?: (requester:unknown) => unknown,
  /** What lavalink-client should do when the player reconnects */
  onDisconnect?: {
    /** Try to reconnect? -> If fails -> Destroy */
    autoReconnect?: boolean,
    /** Instantly destroy player (overrides autoReconnect) */
    destroyPlayer?: boolean,
  },
  /* What the Player should do, when the queue gets empty */
  onEmptyQueue?: {
    /** Get's executed onEmptyQueue -> You can do any track queue previous transformations, if you add a track to the queue -> it will play it, if not queueEnd will execute! */
    autoPlayFunction?: (player:Player, lastPlayedTrack:Track) => Promise<void>,
    /* aut. destroy the player after x ms, if 0 it instantly destroys, don't provide to not destroy the player */
    destroyAfterMs?: number,
  }
}

export interface ManagerOptions {
  nodes: LavalinkNodeOptions[];
  queueOptions?: QueueSaverOptions;
  queueStore?: StoreManager;
  queueChangesWatcher?: QueueChangesWatcher;
  client?: BotClientOptions;
  playerOptions?: LavalinkPlayerOptions;
  autoSkip?: boolean;
  /** @async */
  sendToShard: (guildId:string, payload:GuildShardPayload) => void;
}

interface LavalinkManagerEvents {
    /**
     * Emitted when a Track started playing.
     * @event Manager.playerManager#trackStart
     */
    "trackStart": (player:Player, track: Track, payload:TrackStartEvent) => void;
    /**
     * Emitted when a Track finished.
     * @event Manager.playerManager#trackEnd
     */
    "trackEnd": (player:Player, track: Track, payload:TrackEndEvent) => void;
    /**
     * Emitted when a Track got stuck while playing.
     * @event Manager.playerManager#trackStuck
     */
    "trackStuck": (player:Player, track: Track, payload:TrackStuckEvent) => void;
    /**
     * Emitted when a Track errored.
     * @event Manager.playerManager#trackError
     */
    "trackError": (player:Player, track: Track, payload:TrackExceptionEvent) => void;
    /**
     * Emitted when the Playing finished and no more tracks in the queue.
     * @event Manager.playerManager#queueEnd
     */
    "queueEnd": (player:Player, track: Track, payload:TrackEndEvent|TrackStuckEvent|TrackExceptionEvent) => void;
    /**
     * Emitted when a Player is created.
     * @event Manager.playerManager#create
     */
    "playerCreate": (player:Player) => void;
    /**
     * Emitted when a Player is moved within the channel.
     * @event Manager.playerManager#move
     */
    "playerMove": (player:Player, oldVoiceChannelId: string, newVoiceChannelId: string) => void;
    /**
     * Emitted when a Player is disconnected from a channel.
     * @event Manager.playerManager#disconnect
     */
    "playerDisconnect": (player:Player, voiceChannelId: string) => void;
    /**
     * Emitted when a Node-Socket got closed for a specific Player.
     * @event Manager.playerManager#socketClosed
     */
    "playerSocketClosed": (player:Player, payload: WebSocketClosedEvent) => void;
    /**
     * Emitted when a Player get's destroyed
     * @event Manager.playerManager#destroy
     */
    "playerDestroy": (player:Player, destroyReason?:DestroyReasonsType) => void;
}

export interface LavalinkManager {
  options: ManagerOptions;

  on<U extends keyof LavalinkManagerEvents>(event: U, listener: LavalinkManagerEvents[U]): this;

  emit<U extends keyof LavalinkManagerEvents>(event: U, ...args: Parameters<LavalinkManagerEvents[U]>): boolean;
  
}

export class LavalinkManager extends EventEmitter {
  public static DefaultSources = DefaultSources;
  public static SourceLinksRegexes = SourceLinksRegexes;

  public initiated:boolean = false;
  
  public readonly players: MiniMap<string, Player> = new MiniMap();
    
  private applyDefaultOptions() {

    if(!this.options.playerOptions.defaultSearchPlatform) this.options.playerOptions.defaultSearchPlatform = "ytsearch";
    
    if(typeof this.options?.queueOptions?.maxPreviousTracks !== "number" || this.options.queueOptions.maxPreviousTracks < 0) this.options.queueOptions.maxPreviousTracks = 25;

    return;
  }
  private validateAndApply(options: ManagerOptions) {
    /* QUEUE STORE */
    if(options.queueStore) {
      const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(options.queueStore));
      const requiredKeys = ["get", "set", "stringify", "parse", "delete"];
      if(!requiredKeys.every(v => keys.includes(v)) || !requiredKeys.every(v => typeof options.queueStore[v] === "function")) throw new SyntaxError(`The provided QueueStore, does not have all required functions: ${requiredKeys.join(", ")}`);
    } else this.options.queueStore = new DefaultQueueStore();


  }

  constructor(options: ManagerOptions) {
    super();
    
    // create options
    this.options = {
      autoSkip: true,
      ...options
    };

    // use the validators
    this.applyDefaultOptions();
    this.validateAndApply(options);

    // create classes
    this.nodeManager = new NodeManager(this);
    this.utils = new ManagerUitls(this);

  }
  
  public createPlayer(options: PlayerOptions) {
    if(this.players.has(options.guildId)) return this.players.get(options.guildId)!;
    const newPlayer = new Player(options, this);
    this.players.set(newPlayer.guildId, newPlayer);
    return newPlayer;
  }

  public getPlayer(guildId:string) {
      return this.players.get(guildId);
  }

  public deletePlayer(guildId:string) {
      if(typeof this.players.get(guildId)?.voiceChannelId === "string") throw new Error("Use Player#destroy(true) not PlayerManager#deletePlayer() to stop the Player")
      return this.players.delete(guildId);
  }

  public get useable() {
    return this.nodeManager.nodes.filter(v => v.connected).size > 0;
  }
  /**
   * Initiates the Manager.
   * @param clientData 
   */
  public async init(clientData: BotClientOptions) {
    if (this.initiated) return this;
    this.options.client = { ...(this.options.client||{}), ...clientData };
    if (!this.options.client.id) throw new Error('"client.id" is not set. Pass it in Manager#init() or as a option in the constructor.');
    
    if (typeof this.options.client.id !== "string") throw new Error('"client.id" set is not type of "string"');

    let success = 0;
    for (const node of [...this.nodeManager.nodes.values()]) {
        try {
            await node.connect();
            success++;
        }
        catch (err) {
            console.error(err);
            this.nodeManager.emit("error", node, err);
        }
    }
    if(success > 0) this.initiated = true;
    else console.error("Could not connect to at least 1 Node");
    return this;
  }

  /**
   * Sends voice data to the Lavalink server.
   * @param data
   */
  public async sendRawData(data: VoicePacket | VoiceServer | VoiceState | any): Promise<void> {
    if(!this.initiated) return; 
    if(!("t" in data)) return; 
    
    // for channel Delete
    if("CHANNEL_DELETE" === data.t) {
      const update = "d" in data ? data.d : data;
      if(!update.guild_id) return;
      const player = this.getPlayer(update.guild_id);
      if(player.voiceChannelId === update.id) {
        return player.destroy(DestroyReasons.ChannelDeleted);
      }
    }

    // for voice updates
    if (["VOICE_STATE_UPDATE", "VOICE_SERVER_UPDATE"].includes(data.t)) {
      const update: VoiceServer | VoiceState = "d" in data ? data.d : data;
      if (!update || !("token" in update) && !("session_id" in update)) return;

      const player = this.getPlayer(update.guild_id) as Player;
      if (!player) return;
      
      if ("token" in update) {
        if (!player.node?.sessionId) throw new Error("Lavalink Node is either not ready or not up to date");
        await player.node.updatePlayer({
          guildId: player.guildId,
          playerOptions: {
            voice: {
              token: update.token,
              endpoint: update.endpoint,
              sessionId: player.voice?.sessionId,
            }
          }
        });
        return 
      }

      /* voice state update */
      if (update.user_id !== this.options.client.id) return;      
      
      if (update.channel_id) {
        if (player.voiceChannelId !== update.channel_id) this.emit("playerMove", player, player.voiceChannelId, update.channel_id);
        player.voice.sessionId = update.session_id;
        player.voiceChannelId = update.channel_id;
      } else {
        if(this.options.playerOptions.onDisconnect?.destroyPlayer === true) {
          return await player.destroy(DestroyReasons.Disconnected);
        }
        this.emit("playerDisconnect", player, player.voiceChannelId);

        await player.pause();

        if(this.options.playerOptions.onDisconnect?.autoReconnect === true) {
          try {
            await player.connect();
          } catch {
            return await player.destroy(DestroyReasons.PlayerReconnectFail);
          }
          return await player.resume();
        }

        player.voiceChannelId = null;
        player.voice = Object.assign({});
        return 
      }
      return 
    }
  }
}
