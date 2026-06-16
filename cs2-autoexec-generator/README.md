# CS2 Autoexec Generator

Convierte tus archivos `.vcfg` de Steam en un `Autoexec.cfg` modular y limpio para Counter-Strike 2.

**[→ Abrir la app](https://keplercs.github.io/cs2-autoexec-generator/)**

---

## Qué hace

1. **Detecta automáticamente** tu instalación de Steam y todas las cuentas con datos de CS2
2. **Lee tus archivos `.vcfg`** directamente desde tu PC — sin uploads, sin servidores
3. **Genera un `Autoexec.cfg`** con tus valores reales, organizado en secciones comentadas
4. **Añade scripts opcionales** (demo.cfg, prac.cfg, aliases, presets de crosshair) via checkboxes
5. **Exporta** el archivo directamente a `game/csgo/cfg/`

## Privacidad

Todo el procesamiento ocurre localmente en tu navegador. Ningún archivo es enviado a internet.

## Compatibilidad

Requiere **Chrome 86+** o **Edge 86+** (File System Access API).
Firefox no soporta `showDirectoryPicker()`.

## Estructura del proyecto

```
cs2-autoexec-generator/
├── index.html          ← app completa (paso 1: import)
├── src/
│   ├── parser.js       ← parser VDF/VCFG + generador de autoexec
│   ├── detector.js     ← detector de cuentas Steam (sin API)
│   └── template.cfg    ← plantilla canónica del autoexec
└── .github/
    └── workflows/
        └── deploy.yml  ← GitHub Actions → GitHub Pages
```

## Desarrollo local

```bash
# Cualquier servidor HTTP estático sirve — ejemplo con Python:
python -m http.server 8080
# Luego abrir http://localhost:8080
```

## Pasos del generador

| Paso | Estado |
|------|--------|
| 1 — Importar (Steam folder + detección de cuentas) | ✅ Completo |
| 2 — Preview (vcfg → Autoexec.cfg con valores reales) | 🔨 En construcción |
| 3 — Scripts (checkboxes opcionales) | 🔨 En construcción |
| 4 — Exportar (descarga + escritura directa) | 🔨 En construcción |
