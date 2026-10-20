
#!/usr/bin/env node
/**
 * escpr-compiler.js
 *
 * PDF -> CUPS Raster -> filtro oficial Epson ESC/P-R
 *
 * Requisitos:
 *   - Node.js 20+
 *   - CUPS pdftoraster
 *   - Filtro epson-escpr compilado
 *   - PPD compatible con la impresora seleccionada
 *
 * IMPORTANTE:
 *   Este programa genera un archivo para validar la salida del filtro.
 *   No se conecta a la impresora ni transmite por TCP/9100.
 *
 * Uso:
 *   node escpr-compiler.js entrada.pdf salida.bin
 *
 * Configuración opcional:
 *   PDFTORASTER=/ruta/a/pdftoraster
 *   EPSON_FILTER=/ruta/a/epson-escpr
 *   EPSON_PPD=/ruta/al/perfil.ppd
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { stat, rm } from "node:fs/promises";

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;

const PDFTORASTER =
  process.env.PDFTORASTER ||
  "/usr/lib/cups/filter/pdftoraster";

const EPSON_FILTER =
  process.env.EPSON_FILTER ||
  path.resolve("src/epson-escpr");

const EPSON_PPD = process.env.EPSON_PPD;

function collectStderr(child) {
  let text = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    text += chunk;

    if (text.length > 16000) {
      text = text.slice(-16000);
    }
  });

  return () => text.trim();
}

function waitForExit(child, command, getStderr) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);

    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} falló (código ${code}, señal ${signal || "ninguna"}).\n` +
          (getStderr() || "El proceso no proporcionó detalles.")
        )
      );
    });
  });
}

async function compilePdf(pdfArgument, outputArgument) {
  if (!pdfArgument || !outputArgument) {
    throw new Error(
      "Uso: node escpr-compiler.js entrada.pdf salida.bin"
    );
  }

  const input = path.resolve(pdfArgument);
  const output = path.resolve(outputArgument);

  if (input === output) {
    throw new Error("El archivo de salida no puede sobrescribir el PDF.");
  }

  const inputInfo = await stat(input);

  if (!inputInfo.isFile()) {
    throw new Error("La entrada no es un archivo normal.");
  }

  if (inputInfo.size === 0) {
    throw new Error("El PDF está vacío.");
  }

  if (inputInfo.size > MAX_PDF_BYTES) {
    throw new Error(
      `El PDF supera el límite de ${MAX_PDF_BYTES / 1024 / 1024} MB.`
    );
  }

  await stat(PDFTORASTER);
  await stat(EPSON_FILTER);

  if (EPSON_PPD) {
    await stat(EPSON_PPD);
  }

  await fs.promises.mkdir(path.dirname(output), {
    recursive: true
  });

  const temporaryOutput = `${output}.partial`;

  await rm(temporaryOutput, { force: true });

  console.log("PDF:", input);
  console.log("Tamaño:", inputInfo.size, "bytes");
  console.log("Conversor:", PDFTORASTER);
  console.log("Filtro Epson:", EPSON_FILTER);
  console.log("Perfil PPD:", EPSON_PPD || "(no especificado)");
  console.log("Iniciando conversión...");

  const env = { ...process.env };

  if (EPSON_PPD) {
    env.PPD = EPSON_PPD;
  }

  // Los filtros CUPS reciben:
  // job-id, user, title, copies, options.
  // La entrada del primer filtro es el PDF por stdin.
  const raster = spawn(
    PDFTORASTER,
    ["1", "print-user", "PDF job", "1", ""],
    {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  const rasterError = collectStderr(raster);

  // El segundo filtro recibe CUPS Raster por stdin.
  const epson = spawn(
    EPSON_FILTER,
    ["1", "print-user", "PDF job", "1", ""],
    {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  const epsonError = collectStderr(epson);

  let outputBytes = 0;

  const outputStream = fs.createWriteStream(temporaryOutput, {
    flags: "wx"
  });

  outputStream.on("pipe", () => {});

  epson.stdout.on("data", chunk => {
    outputBytes += chunk.length;

    if (outputBytes > MAX_OUTPUT_BYTES) {
      const error = new Error(
        `La salida supera el límite de ${MAX_OUTPUT_BYTES / 1024 / 1024} MB.`
      );

      raster.kill();
      epson.kill();
      outputStream.destroy(error);
    }
  });

  const exits = Promise.all([
    waitForExit(raster, PDFTORASTER, rasterError),
    waitForExit(epson, EPSON_FILTER, epsonError)
  ]);

  try {
    // Conectar los tres componentes sin almacenar el raster completo
    // en memoria. Los flujos trabajan página a página.
    const streams = Promise.all([
      pipeline(
        fs.createReadStream(input),
        raster.stdin
      ),
      pipeline(
        raster.stdout,
        epson.stdin
      ),
      pipeline(
        epson.stdout,
        outputStream
      )
    ]);

    await Promise.all([streams, exits]);

    if (outputBytes === 0) {
      throw new Error(
        "El filtro terminó sin producir datos de salida."
      );
    }

    await fs.promises.rename(temporaryOutput, output);

    console.log("\nConversión finalizada.");
    console.log("Archivo generado:", output);
    console.log("Salida:", outputBytes, "bytes");
    console.log(
      "Nota: aún debe comprobarse que la salida sea válida para el modelo y perfil seleccionados."
    );
  } catch (error) {
    raster.kill();
    epson.kill();
    outputStream.destroy();

    await rm(temporaryOutput, { force: true }).catch(() => {});

    throw new Error(
      `${error.message}\n` +
      `pdftoraster: ${rasterError() || "(sin mensajes)"}\n` +
      `filtro Epson: ${epsonError() || "(sin mensajes)"}`
    );
  }
}

compilePdf(process.argv[2], process.argv[3]).catch(error => {
  console.error("\nERROR:", error.message);
  process.exitCode = 1;
});
