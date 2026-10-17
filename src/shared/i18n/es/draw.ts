// draw: Spanish (Spain), composed natively, never translated word for word. Glossary in ../GLOSSARY.md.
import type { Shape } from "../core";
import type { draw as en } from "../en/draw";

export const draw: Shape<typeof en> = {
  "draw.toolbarWindowTitle": "Herramientas de dibujo de OpenTake",
  "draw.strokesWindowTitle": "Dibujo de OpenTake",
  "draw.cardHint": "Dibuja sobre cualquier cosa de tu pantalla mientras grabas. El dibujo sale en la grabación, la barra de herramientas no.",
  "draw.shortcutHint": "Empieza y termina el dibujo desde cualquier app",
  "draw.shortcutTaken": "Otra app ya usa {shortcut}",
  "draw.stop": "Dejar de dibujar",
  "draw.start": "Dibujar",
  "draw.fade": "Desvanecer los trazos a los 3 s",
  "draw.fadeHint": "Desactivado: los trazos se quedan hasta que los borres (C) o los deshagas",

  "draw.tools": "Herramientas de dibujo",
  "draw.tool.pen": "Lápiz",
  "draw.tool.highlighter": "Rotulador",
  "draw.tool.arrow": "Flecha",
  "draw.tool.rect": "Rectángulo",
  "draw.withKey": "{label} ({key})",
  "draw.color.red": "Rojo",
  "draw.color.yellow": "Amarillo",
  "draw.color.green": "Verde",
  "draw.color.blue": "Azul",
  "draw.color.white": "Blanco",
  "draw.fadeOnHint": "Los trazos se desvanecen a los 3 segundos. Haz clic para que se queden",
  "draw.fadeOffHint": "Los trazos se quedan hasta que los borres. Haz clic para que se desvanezcan",
  "draw.fadeStrokes": "Desvanecer trazos",
  "draw.undo": "Deshacer",
  "draw.undoHint": "Deshacer ({keys})",
  "draw.clearAll": "Borrar todo",
  "draw.clearAllHint": "Borrar todo (C)",
  "draw.stopHint": "Dejar de dibujar (Esc o {shortcut})",
  "draw.hint.stop": "salir",
  "draw.hint.undo": "deshacer",
  "draw.hint.clear": "borrar",
  "draw.hint.rubOut": "Clic derecho borra un trazo",
};
