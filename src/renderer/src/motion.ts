/** Shared Motion transitions for the redesign. Keep every animated component on these so the app moves as one system. */
import type { Transition } from 'motion/react'

/** Panels, popovers, filmstrip landings: quick, almost no overshoot. */
export const firm: Transition = { type: 'spring', visualDuration: 0.3, bounce: 0.1 }
/** Setup card, bottom sheets: a touch softer and longer. */
export const soft: Transition = { type: 'spring', visualDuration: 0.4, bounce: 0.3 }
/** Opacity and colour: never spring these. */
export const fade: Transition = { duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }

/** A new frame landing in the filmstrip or grid. */
export const landIn = { initial: { x: 56, scale: 0.9, opacity: 0 }, animate: { x: 0, scale: 1, opacity: 1 }, transition: firm }
/** A card or sheet rising into place. */
export const riseIn = { initial: { y: 24, opacity: 0 }, animate: { y: 0, opacity: 1 }, exit: { y: 24, opacity: 0 }, transition: soft }
/** A popover anchored to its button. */
export const popIn = { initial: { y: 8, scale: 0.97, opacity: 0 }, animate: { y: 0, scale: 1, opacity: 1 }, exit: { y: 8, scale: 0.97, opacity: 0 }, transition: firm }
/** A side sheet sliding in from the right. */
export const slideIn = { initial: { x: 60, opacity: 0 }, animate: { x: 0, opacity: 1 }, exit: { x: 60, opacity: 0 }, transition: firm }
