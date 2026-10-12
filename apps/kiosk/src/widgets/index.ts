import { Registry } from "../sdk";
import clock from "./clock";
import pcTemps from "./pc-temps";
import pcDrives from "./pc-drives";
import buttons from "./buttons";
import lights from "./lights";
import entity from "./entity";
import camera from "./camera";
import media from "./media";
import text from "./text";

/** Adding a widget: create src/widgets/<name>.tsx with defineWidget(...) and register it here. */
export const registry = new Registry()
  .register(clock)
  .register(pcTemps)
  .register(pcDrives)
  .register(buttons)
  .register(lights)
  .register(entity)
  .register(camera)
  .register(media)
  .register(text);
