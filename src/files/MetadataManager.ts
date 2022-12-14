import path from "path";
import { logger, rootDir } from "../Server";
import fs from "fs-extra";
import crypto from "crypto";
import LineReader from "./LineReader";
import Database from "../database/Database";
import HashUtils from "./HashUtils";
import MarlinRaker from "../MarlinRaker";

interface IThumbnail {
    width: number;
    height: number;
    size: number;
    relative_path: string;
}

interface IGcodeMetadata {
    print_start_time: number | null;
    job_id: string | null;
    size: number;
    modified: number;
    slicer?: string;
    slicer_version?: string;
    layer_height?: number;
    first_layer_height?: number;
    object_height?: number;
    filament_total?: number;
    estimated_time?: number;
    thumbnails?: IThumbnail[];
    first_layer_bed_temp?: number;
    first_layer_extr_temp?: number;
    gcode_start_byte?: number;
    gcode_end_byte?: number;
    filename: string;

    // these are undocumented...
    nozzle_diameter?: number;
    filament_name?: string;
    filament_type?: string;
    filament_weight_total?: number;

    // for watching changes
    mtimeMs: number;
}

class MetadataManager {

    private readonly database: Database;

    public constructor(marlinRakerInstance: MarlinRaker) {
        this.database = marlinRakerInstance.database;
        void this.cleanupFiles(true);
    }

    public async cleanupFiles(verbose: boolean): Promise<void> {

        const usedThumbnails: string[] = [];
        const allMetadata = await this.database.getItem("gcode_metadata") as Record<string, IGcodeMetadata>;
        for (const id in allMetadata) {
            const metadata = allMetadata[id];
            const filepath = path.join(rootDir, "gcodes", metadata.filename);
            if (!await fs.pathExists(filepath)) {
                await this.deleteById(id);
            } else {
                metadata.thumbnails?.forEach((thumbnail) => {
                    usedThumbnails.push(path.join(rootDir, "gcodes",
                        path.dirname(metadata.filename), thumbnail.relative_path));
                });
            }
        }

        let deleted = 0, deletedSize = 0;
        const pathsToCheck = [path.join(rootDir, "gcodes")];
        while (pathsToCheck.length) {
            const currentPath = pathsToCheck.pop()!;
            const files = await fs.readdir(currentPath);
            for (const fileName of files) {
                const filePath = path.join(currentPath, fileName);
                const stat = await fs.stat(filePath);
                if (stat.isDirectory()) {
                    pathsToCheck.push(filePath);
                } else if (stat.isFile()) {
                    if (/.*\.thumbs[\\/].*\.png$/.test(filePath) && !usedThumbnails.includes(filePath)) {
                        deleted++;
                        deletedSize += stat.size;
                        await fs.remove(filePath);
                    } else if (/.*\.gcode$/i.test(fileName)) {
                        await this.getOrGenerateMetadata(path.relative(path.join(rootDir, "gcodes"), filePath));
                    }
                }
            }
        }

        if (deleted && verbose) {
            logger.warn(`Deleted ${deleted} unused thumbnail files (${Math.round(deletedSize / 10000) / 10} MB)`);
        }
    }

    public async listDir(dirpath: string): Promise<IGcodeMetadata[]> {
        const allMetadata = (await this.database.getItem("gcode_metadata") ?? {}) as Record<string, IGcodeMetadata>;
        const content: IGcodeMetadata[] = [];
        for (const id in allMetadata) {
            const metadata = allMetadata[id];
            if (!path.relative(dirpath, metadata.filename).startsWith(".")) {
                content.push(metadata);
            }
        }
        return content;
    }

    public async getOrGenerateMetadata(filename: string): Promise<IGcodeMetadata | null> {

        const filepath = path.join(rootDir, "gcodes", filename);
        if (!await fs.pathExists(filepath)) {
            return null;
        }

        const stat = await fs.stat(filepath);
        const id = this.getId(filename);

        let metadata = await this.database.getItem("gcode_metadata", id) as IGcodeMetadata | null;
        if (metadata) {
            if (metadata.mtimeMs !== stat.mtimeMs) {
                await this.deleteById(id);
            } else {
                return metadata;
            }
        }

        metadata = await this.generateMetadata(filename);
        if (metadata) await this.storeMetadata(metadata);
        return metadata;
    }

    public async storeMetadata(metadata: IGcodeMetadata): Promise<void> {
        const id = this.getId(metadata.filename);
        await this.database.addItem("gcode_metadata", id, metadata);
    }

    public async removeJobIds(ids: string[]): Promise<void> {
        const allMetadata = (await this.database.getItem("gcode_metadata") ?? {}) as Record<string, IGcodeMetadata>;
        for (const id in allMetadata) {
            const metadata = allMetadata[id];
            if (metadata.job_id && ids.includes(metadata.job_id)) {
                metadata.job_id = null;
            }
        }
        await this.database.addItem("gcode_metadata", undefined, allMetadata);
    }

    public getId(filename: string): string {
        return HashUtils.hashStringMd5(filename.toLowerCase());
    }

    public async delete(metadata: IGcodeMetadata): Promise<void> {
        return this.deleteById(this.getId(metadata.filename));
    }

    public async deleteById(id: string): Promise<void> {
        const metadata = await this.database.getItem("gcode_metadata", id) as IGcodeMetadata | null;
        if (!metadata) return;
        for (const thumbnail of metadata.thumbnails ?? []) {
            const thumbnailPath = path.join(rootDir, "gcodes", path.dirname(metadata.filename), thumbnail.relative_path);
            await fs.remove(thumbnailPath);
        }
        await this.database.deleteItem("gcode_metadata", id);
    }

    public async generateMetadata(filename: string): Promise<IGcodeMetadata | null> {

        const filepath = path.join(rootDir, "gcodes", filename);
        if (!await fs.pathExists(filepath)) {
            return null;
        }

        const stat = await fs.stat(filepath);
        const metadata: IGcodeMetadata = {
            job_id: null,
            print_start_time: null,
            filename,
            size: stat.size,
            modified: stat.mtimeMs / 1000,
            mtimeMs: stat.mtimeMs
        };

        const firstLineReader = new LineReader(fs.createReadStream(filepath));
        for (; ;) {
            const line = await firstLineReader.readLine();
            if (line === null) break;

            if (!line.trim()) continue;
            if (!line.trim().startsWith(";")) {
                metadata.gcode_start_byte = firstLineReader.position;
                break;
            }

            const comment = line.trim().substring(1).trim();
            if (!comment) continue;

            if (comment.startsWith("generated by") || comment.startsWith("Generated with")) {
                [metadata.slicer, metadata.slicer_version] = comment.split(" ").slice(2, 4);

            } else if (comment.startsWith("thumbnail begin")) {
                const [width, height, size] = comment.split(" ")
                    .flatMap((s) => s.split("x"))
                    .slice(-3)
                    .map((s) => Number.parseInt(s));
                const relativePath = await MetadataManager.extractThumbnail(firstLineReader, filename);
                if (!relativePath) continue;
                metadata.thumbnails ??= [];
                metadata.thumbnails.push({
                    width, height, size,
                    relative_path: relativePath
                });

            } else if (comment.includes(":")) {
                const [key, value] = comment.split(":").map((s) => s.trim());
                if (key === "TIME") {
                    metadata.estimated_time = Number.parseInt(value);
                } else if (key === "MAXZ") {
                    metadata.object_height = Number.parseFloat(value);
                } else if (key === "Filament used") {
                    metadata.filament_total = Number.parseFloat(value.substring(0, value.length - 1)) * 1000;
                } else if (key === "Layer height") {
                    metadata.layer_height = Number.parseFloat(value);
                }
            }
        }
        firstLineReader.close();

        const start = Math.max(stat.size - 50000, 0);
        const last50kReader = new LineReader(fs.createReadStream(filepath, {
            start,
            end: stat.size
        }));
        for (; ;) {
            const line = await last50kReader.readLine();
            if (line === null) break;

            if (!line.trim()) continue;
            if (!line.trim().startsWith(";")) {
                metadata.gcode_end_byte = start + last50kReader.position + Buffer.byteLength(line, "utf-8");
            } else {
                const comment = line.trim().substring(1).trim();

                if (comment.startsWith("Z:")) {
                    const z = Number.parseFloat(comment.substring(2));
                    metadata.object_height ??= 0;
                    metadata.object_height = Math.max(metadata.object_height, z);
                    continue;
                }

                if (!comment.includes("=")) continue;
                const [key, value] = comment.split("=").map((s) => s.trim());
                if (key === "layer_height") {
                    metadata.layer_height = Number.parseFloat(value);
                } else if (key === "first_layer_height") {
                    metadata.first_layer_height = Number.parseFloat(value);
                } else if (key === "filament used [mm]") {
                    metadata.filament_total = Number.parseFloat(value);
                } else if (key === "estimated printing time (normal mode)") {
                    let timeInSeconds = 0;
                    value.split(" ").forEach((s) => {
                        const t = Number.parseInt(s.substring(0, s.length - 1));
                        const unit = s[s.length - 1];
                        if (unit === "s") {
                            timeInSeconds += t;
                        } else if (unit === "m") {
                            timeInSeconds += t * 60;
                        } else if (unit === "h") {
                            timeInSeconds += t * 60 * 60;
                        } else if (unit === "d") {
                            timeInSeconds += t * 24 * 60 * 60;
                        }
                    });
                    metadata.estimated_time = timeInSeconds;
                } else if (key === "first_layer_bed_temperature") {
                    metadata.first_layer_bed_temp = Number.parseFloat(value);
                } else if (key === "first_layer_temperature") {
                    metadata.first_layer_extr_temp = Number.parseFloat(value);
                } else if (key === "nozzle_diameter") {
                    metadata.nozzle_diameter = Number.parseFloat(value);
                } else if (key === "filament_settings_id") {
                    metadata.filament_name = value;
                } else if (key === "filament_type") {
                    metadata.filament_type = value;
                } else if (key === "filament used [g]") {
                    metadata.filament_weight_total = Number.parseFloat(value);
                }
            }
        }
        last50kReader.close();

        return metadata;
    }

    private static async extractThumbnail(lineReader: LineReader, filename: string): Promise<string | null> {
        let base64 = "";

        for (; ;) {
            const line = await lineReader.readLine();
            if (line === null) break;
            if (!line.trim()) continue;
            if (!line.trim().startsWith(";")) break;
            const comment = line.trim().substring(1).trim();
            if (comment === "thumbnail end") break;
            base64 += comment;
        }

        let buf: Buffer;
        try {
            buf = Buffer.from(base64, "base64");
        } catch (e) {
            return null;
        }

        const thumbnailName = crypto.randomUUID() + ".png";
        const relativeLocation = `.thumbs/${thumbnailName}`;
        const pathOnDisk = path.join(rootDir, "gcodes", path.dirname(filename), relativeLocation);
        await fs.mkdirs(path.dirname(pathOnDisk));
        await fs.writeFile(pathOnDisk, buf);
        return relativeLocation;
    }
}

export { IGcodeMetadata };
export default MetadataManager;