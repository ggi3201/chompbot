import { motion } from "motion/react";

interface ChoiceCardsProps {
  options: string[];
  onPick: (option: string) => void;
}

/** People choose between real replies far better than they describe a voice. */
export default function ChoiceCards({ options, onPick }: ChoiceCardsProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 30, damping: 13 }}
      className="grid gap-2.5 md:grid-cols-2"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onPick(option)}
          className="cursor-pointer whitespace-pre-wrap rounded-xl border border-white/10 bg-[#0a0b0f]/80 px-4 py-3.5 text-left text-[15px] leading-[1.5] text-text-secondary transition-colors hover:border-accent/50 hover:text-text-primary"
        >
          {option}
        </button>
      ))}
    </motion.div>
  );
}
