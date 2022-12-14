import { IMethodExecutor, TSender } from "./IMethodExecutor";
import { config, logger } from "../../Server";
import MarlinRaker, { TPrinterState } from "../../MarlinRaker";
import { Level } from "../../logger/Logger";
import packageJson from "../../../package.json";

interface IResult {
    klippy_connected: boolean;
    klippy_state: TPrinterState;
    components: string[];
    failed_components: string[];
    registered_directories: string[];
    warnings: string[];
    websocket_count: number;
    moonraker_version: string;
    api_version: number[];
    api_version_string: string;
    type: string;
}

class ServerInfoExecutor implements IMethodExecutor<undefined, IResult> {

    public readonly name = "server.info";
    private readonly versionArray: number[];
    private readonly marlinRaker: MarlinRaker;

    public constructor(marlinRaker: MarlinRaker) {
        this.marlinRaker = marlinRaker;
        this.versionArray = packageJson.version
            .replace(/[^0-9.]/g, "")
            .split(".")
            .map((s) => Number.parseInt(s))
            .filter((n) => !Number.isNaN(n));
    }

    public invoke(_: TSender, __: undefined): IResult {
        const warnings = config.warnings.slice();
        if (logger.level > Level.info && process.env.NODE_ENV !== "development") {
            warnings.push("\"extended_logs\" is enabled. Only use this option for debugging purposes. This option can affect print performance.");
        }
        const components = [
            "server",
            "file_manager",
            "machine",
            "database",
            "data_store",
            "proc_stats",
            "history"
        ];
        if (this.marlinRaker.updateManager.updatables.size) {
            components.push("update_manager");
        }

        return {
            klippy_connected: true,
            klippy_state: this.marlinRaker.state,
            components,
            failed_components: [],
            registered_directories: ["gcodes", "config"],
            warnings,
            websocket_count: this.marlinRaker.connectionManager.connections.length,
            moonraker_version: packageJson.version,
            api_version: this.versionArray,
            api_version_string: packageJson.version,
            type: "marlinraker"
        };
    }
}

export default ServerInfoExecutor;
