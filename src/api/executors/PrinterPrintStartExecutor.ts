import { IMethodExecutor, TSender } from "./IMethodExecutor";
import { marlinRaker } from "../../Server";

interface IParams {
    filename: string;
}

class PrinterPrintStartExecutor implements IMethodExecutor<IParams, string> {

    public readonly name = "printer.print.start";
    public readonly timeout = null;

    public async invoke(_: TSender, params: Partial<IParams>): Promise<string> {
        if (!params.filename) throw new Error("Invalid filename");
        await marlinRaker.jobManager.selectFile(`gcodes/${params.filename}`);
        await marlinRaker.printer?.dispatchCommand("start_print", false);
        return "ok";
    }
}

export default PrinterPrintStartExecutor;