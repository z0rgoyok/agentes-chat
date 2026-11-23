import { FadeOut, Keyframe } from "react-native-reanimated";
import { motion } from "./theme";

/*
 * The app's entrances and exits for a part that comes and goes (layout animations: opacity and transform only, on the
 * UI thread). Arrivals take `motion.base` on the strong ease-out, exits `motion.fast`. Where Reduce Motion is on, the
 * caller passes none and the part appears and goes at once.
 */

/** Rises 6 points into place as it fades in: a row arriving at the conversation's end, a line or bar over the field. */
export const RISE_IN = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 6 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }], easing: motion.easeOut },
}).duration(motion.base);

/** Fades in where it stands (something drawn over what stays, as the recording over the field). */
export const FADE_IN = new Keyframe({ 0: { opacity: 0 }, 100: { opacity: 1, easing: motion.easeOut } }).duration(
  motion.base,
);

/** Lands with a click: from 0.94, no overshoot (a state that just turned on, as "Travado"). */
export const CLICK_IN = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.94 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: motion.easeOut },
}).duration(motion.base);

/** Fades out, quicker than it came. */
export const FADE_OUT = FadeOut.duration(motion.fast);
