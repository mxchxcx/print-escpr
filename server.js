import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const UPLOAD_ROOT = path.join(__dirname, "tmp", "uploads");
const OUTPUT_ROOT = path.join(__dirname, "tmp", "output");

const defaultPpd = path.join(__dirname, "ppd", "Epson-L355-epson-escpr-en.ppd");
const defaultFilter = path.join(__dirname, "src", "epson-escpr");
const defaultPdfToRaster = process.env.PDFTORASTER || "/usr/lib/cups/filter/pdftoraster";

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await fs.mkdir(UPLOAD_ROOT, { recursive: true });
    cb(null, UPLOAD_ROOT);
  },
  filename: (_req, file, cb) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ext = path.extname(file.originalname || ".pdf");
    cb(null, `${stamp}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdf = file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      cb(new Error("Solo se aceptan archivos PDF."));
      return;
    }
    cb(null, true);
  }
});

async function compileSinglePdf({ inputPath, outputPath, env }) {
  const scriptPath = path.join(__dirname, "escpr-compiler.js");
  const child = spawn(process.execPath, [scriptPath, inputPath, outputPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", chunk => {
    stderr += chunk.toString();
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", async code => {
      if (code !== 0) {
        reject(new Error(stderr || `El proceso falló con código ${code}.`));
        return;
      }

      try {
        const outputSize = (await fs.stat(outputPath)).size;
        resolve({ outputSize });
      } catch (error) {
        reject(error);
      }
    });
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "escpr-backend",
    model: "EPSON L355",
    ppd: defaultPpd,
    filter: defaultFilter,
    pdfToRaster: defaultPdfToRaster
  });
});

app.post("/api/print", upload.array("files", 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "Falta al menos un archivo PDF." });
    }

    const paperSize = req.body.paperSize || "A4";
    const mediaType = req.body.mediaType || "PLAIN_NORMAL";
    const ink = req.body.ink || "COLOR";
    const copies = Number(req.body.copies || 1);

    const ppdPath = process.env.EPSON_PPD || defaultPpd;
    const filterPath = process.env.EPSON_FILTER || defaultFilter;

    const env = {
      ...process.env,
      PDFTORASTER: process.env.PDFTORASTER || defaultPdfToRaster,
      EPSON_PPD: ppdPath,
      EPSON_FILTER: filterPath,
      PAPER_SIZE: paperSize,
      MEDIA_TYPE: mediaType,
      INK_MODE: ink,
      COPIES: String(copies)
    };

    const results = [];

    for (const file of files) {
      const inputPath = file.path;
      const baseName = path.basename(file.filename, path.extname(file.filename));
      const outputPath = path.join(OUTPUT_ROOT, `${baseName}.bin`);

      await fs.mkdir(OUTPUT_ROOT, { recursive: true });

      const { outputSize } = await compileSinglePdf({ inputPath, outputPath, env });
      const fileName = path.basename(outputPath);

      await fs.unlink(inputPath).catch(() => {});

      results.push({
        ok: true,
        input: file.originalname,
        outputFile: fileName,
        downloadUrl: `/api/download/${encodeURIComponent(fileName)}`,
        outputBytes: outputSize,
        paperSize,
        mediaType,
        ink,
        copies,
        message: "PDF convertido con el flujo Epson ESC/P-R."
      });
    }

    return res.json({
      ok: true,
      model: "EPSON L355",
      results
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Error inesperado en la conversión."
    });
  }
});

app.get("/api/download/:fileName", async (req, res) => {
  const fileName = decodeURIComponent(req.params.fileName);
  const filePath = path.join(OUTPUT_ROOT, fileName);

  try {
    const file = await fs.readFile(filePath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(file);
  } catch (error) {
    res.status(404).json({ ok: false, error: "Archivo no encontrado." });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  return res.status(400).json({ ok: false, error: err.message || "Error de entrada." });
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log(`PPD por defecto: ${defaultPpd}`);
  console.log(`Filtro por defecto: ${defaultFilter}`);
});
