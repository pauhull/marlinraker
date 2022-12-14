import { IMacro } from "./IMacro";
import { logger } from "../../Server";
import SimpleNotification from "../../api/notifications/SimpleNotification";
import Utils from "../../util/Utils";
import path from "path";
import MarlinRaker from "../../MarlinRaker";

type TGcodeEvaluator = (args: Record<string, string>, printer: unknown) => string;

class CustomMacro implements IMacro {

    public readonly name: string;
    public readonly evaluate: TGcodeEvaluator;

    public constructor(name: string, evaluate: TGcodeEvaluator) {
        this.name = name;
        this.evaluate = evaluate;
    }

    public async execute(args: Record<string, string>): Promise<void> {
        const marlinRaker = MarlinRaker.getInstance();
        const printer = marlinRaker.printer;
        if (!printer) return;

        const printJob = marlinRaker.jobManager.currentPrintJob;
        const printJobObj = printJob && {
            state: marlinRaker.jobManager.state,
            filepath: printJob.filename,
            filename: path.basename(printJob.filename),
            filePosition: printJob.filePosition,
            progress: printJob.progress,
            isPrinting: marlinRaker.jobManager.isPrinting(),
            isReadyToPrint: marlinRaker.jobManager.isReadyToPrint()
        };

        const printerObject = Object.freeze({
            state: marlinRaker.state,
            stateMessage: marlinRaker.stateMessage,
            x: printer.actualPosition[0],
            y: printer.actualPosition[1],
            z: printer.actualPosition[2],
            e: printer.actualPosition[3],
            pauseState: printer.pauseState,
            hasEmergencyParser: printer.hasEmergencyParser,
            speedFactor: printer.speedFactor,
            extrudeFactor: printer.extrudeFactor,
            fanSpeed: printer.fanSpeed,
            capabilities: printer.capabilities,
            isAbsolute: printer.isAbsolutePositioning,
            isAbsoluteE: printer.isAbsoluteEPositioning,
            feedrate: printer.feedrate,
            info: printer.info,
            isM73Supported: printer.isM73Supported,
            isPrusa: printer.isPrusa,
            printJob: printJobObj
        });

        try {
            const gcode = this.evaluate(args, printerObject);
            await marlinRaker.dispatchCommand(gcode, false);
        } catch (e) {
            logger.error(`Cannot evaluate gcode macro "${this.name}":`);
            logger.error(e);
            const errorStr = `!! Error on '${this.name}': ${Utils.errorToString(e)}`;
            await marlinRaker.socketHandler.broadcast(new SimpleNotification("notify_gcode_response", [errorStr]));
        }
    }
}

export { TGcodeEvaluator };
export default CustomMacro;