import {
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { D2SequenceRenderer } from "./renderer.js";
import { readDiagram } from "./sequence.js";

export async function runRenderCli(args: string[]): Promise<string> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      quality: { type: "string" },
      scale: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    return "Usage: invariant-monitor render --input <display.json> --output <prefix> [--quality 90] [--scale 1]\n";
  if (!values.input || !values.output)
    throw new Error("Specify --input and --output for rendering.");
  const input = readDiagram(JSON.parse(await readFile(values.input, "utf8")));
  const paths = ["d2", "svg", "jpg"].map(
    (extension) => `${values.output}.${extension}`,
  );
  const files: { path: string; handle: FileHandle }[] = [];
  await mkdir(dirname(values.output), { recursive: true });
  let completed = false;
  try {
    for (const path of paths)
      files.push({ path, handle: await open(path, "wx") });
    const result = await new D2SequenceRenderer().render(input, {
      quality: Number(values.quality ?? 90),
      scale: Number(values.scale ?? 1),
    });
    await files[0]!.handle.writeFile(result.source);
    await files[1]!.handle.writeFile(result.svg);
    await files[2]!.handle.writeFile(result.jpeg);
    completed = true;
    return `Rendered ${result.width} × ${result.height}.\n${paths.map((path) => `Saved ${path}`).join("\n")}\n`;
  } finally {
    await Promise.all(files.map((file) => file.handle.close()));
    if (!completed) await Promise.all(files.map((file) => unlink(file.path)));
  }
}
