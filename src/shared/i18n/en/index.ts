import { ui } from "./ui";
import { app } from "./app";
import { shell } from "./shell";
import { record } from "./record";
import { camera } from "./camera";
import { audio } from "./audio";
import { prompter } from "./prompter";
import { draw } from "./draw";
import { editor } from "./editor";
import { update } from "./update";
import { main } from "./main";
import { assistant } from "./assistant";

export const en = { ...ui, ...app, ...shell, ...record, ...camera, ...audio, ...prompter, ...draw, ...editor, ...update, ...main, ...assistant };
