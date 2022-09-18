import PrinterObject from "./PrinterObject";
import { marlinRaker } from "../../Server";

interface IObject {
    progress: number;
    is_active: boolean;
    file_position: number;
}

class VirtualSdCardObject extends PrinterObject<IObject> {

    public readonly name = "virtual_sdcard";

    public constructor() {
        super();
    }

    protected get(_: string[] | null): IObject {
        return {
            progress: marlinRaker.jobManager.currentPrintJob?.progress ?? 0,
            is_active: marlinRaker.jobManager.currentPrintJob?.state === "printing",
            file_position: marlinRaker.jobManager.currentPrintJob?.filePosition ?? 0
        };
    }
}

export default VirtualSdCardObject;