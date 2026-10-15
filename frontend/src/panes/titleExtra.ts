import { createContext, ReactNode } from "react";

/**
 * What goes beside a card's title (its results' Clear), for a card without
 * one: its one output draws its own title row (the HTTP client's Response,
 * its status beside it) and puts this at the end of it.
 */
export const TitleExtra = createContext<ReactNode>(null);
