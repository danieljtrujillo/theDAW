import React, { useState } from "react";
import { ElementType, CustomModule, UIElement } from "../types";
import type { ArsenalEntry } from "../lib/arsenal";
import CustomCodeFrame from "./CustomCodeFrame";
import {
  MousePointer2,
  Circle,
  SlidersHorizontal,
  Type,
  ToggleLeft,
  ChevronDown,
  LayoutGrid,
  Activity,
  BarChart2,
  Move,
  Box,
  Boxes,
  Code,
  Save,
  AudioWaveform,
  Square,
  X,
} from "lucide-react";

interface ComponentVariant {
  type: ElementType;
  variant: string;
  label: string;
  description?: string;
  defaultWidth: number;
  defaultHeight: number;
  preview: React.ReactNode;
}

interface ComponentCategory {
  name: string;
  icon: React.FC<any>;
  variants: ComponentVariant[];
}

const CATEGORIES: ComponentCategory[] = [
  {
    name: "Knobs",
    icon: Circle,
    variants: [
      {
        type: "Knob",
        variant: "Blank",
        label: "Blank Knob",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 64,
        defaultHeight: 64,
        preview: (
          <div className="w-12 h-12 rounded-full border border-zinc-600 bg-zinc-700 flex items-start justify-center pt-1">
            <div className="w-1 h-3 bg-zinc-500 rounded-full" />
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "Modernism",
        label: "Modernism",
        defaultWidth: 64,
        defaultHeight: 64,
        preview: (
          <div className="w-12 h-12 rounded-full border-2 border-app-main bg-app-surface flex items-start justify-center pt-1">
            <div className="w-1 h-3 bg-app-main rounded-full" />
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "Skeuomorphic",
        label: "Skeuomorphic",
        defaultWidth: 64,
        defaultHeight: 64,
        preview: (
          <div className="w-12 h-12 rounded-full border-4 border-app-border bg-app-surface-hover flex items-start justify-center shadow-inner">
            <div className="w-1.5 h-4 bg-gray-300 rounded-sm mt-0.5" />
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "Minimalist",
        label: "Minimalist",
        defaultWidth: 48,
        defaultHeight: 48,
        preview: (
          <div className="w-10 h-10 rounded-full border-2 border-white/20 bg-transparent flex items-start justify-center">
            <div className="w-1 h-3 bg-white/60 rounded-full mt-1" />
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "Apple-esque Minimalism",
        label: "Apple-esque",
        defaultWidth: 64,
        defaultHeight: 64,
        preview: (
          <div className="w-12 h-12 rounded-full bg-app-surface shadow-[inset_2px_2px_5px_rgba(0,0,0,0.5),inset_-2px_-2px_5px_rgba(255,255,255,0.1)] flex items-start justify-center pt-2">
            <div className="w-1 h-2 bg-gray-400 rounded-full shadow-[0_0_2px_rgba(0,0,0,0.8)]" />
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "Swiss Style",
        label: "Swiss Style",
        defaultWidth: 64,
        defaultHeight: 64,
        preview: (
          <div className="w-12 h-12 rounded-none border-[3px] border-white bg-black flex items-start justify-center pt-1">
            <div className="w-2 h-4 bg-white" />
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "Morphogenetic Design",
        label: "Morphogenetic",
        defaultWidth: 64,
        defaultHeight: 64,
        preview: (
          <div className="w-12 h-12 rounded-full border-4 border-black bg-yellow-400 flex items-start justify-center pt-1 shadow-[2px_2px_0_0_#000]">
            <div className="w-1.5 h-3 bg-black rounded-full" />
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "Space Age Design",
        label: "Space Age",
        defaultWidth: 64,
        defaultHeight: 64,
        preview: (
          <div className="w-12 h-12 rounded-full bg-linear-to-br from-gray-700 to-gray-900 border border-app-border flex items-start justify-center pt-1 shadow-[0_4px_6px_rgba(0,0,0,0.5),inset_0_2px_4px_rgba(255,255,255,0.1)]">
            <div className="w-1.5 h-3 bg-linear-to-b from-gray-300 to-gray-500 rounded-full shadow-sm" />
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "Encoder",
        label: "Encoder",
        description: "An endless rotary encoder with an LED ring indicator.",
        defaultWidth: 80,
        defaultHeight: 80,
        preview: (
          <div className="w-12 h-12 rounded-full bg-app-base border border-app-border flex items-center justify-center relative shadow-inner">
            <div className="absolute inset-0 border-2 border-app-main/50 rounded-full" style={{ clipPath: 'polygon(0 0, 50% 0, 50% 50%, 0 50%)' }} />
            <div className="w-8 h-8 rounded-full bg-app-surface border border-app-border" />
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "Aluminum",
        label: "Aluminum Knob",
        description: "A brushed-aluminum knob with a machined metallic finish.",
        defaultWidth: 64,
        defaultHeight: 64,
        preview: (
          <div className="w-12 h-12 rounded-full bg-linear-to-br from-gray-300 to-gray-500 border border-gray-400 flex items-start justify-center pt-1 shadow-[inset_0_1px_2px_rgba(255,255,255,0.6),0_2px_4px_rgba(0,0,0,0.5)]">
            <div className="w-1 h-3 bg-gray-700 rounded-full" />
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "Vintage",
        label: "Vintage Knob",
        description: "A classic bakelite amplifier knob with a pointer skirt.",
        defaultWidth: 64,
        defaultHeight: 64,
        preview: (
          <div className="w-12 h-12 rounded-full bg-linear-to-b from-neutral-800 to-black border-2 border-neutral-700 flex items-start justify-center pt-1 shadow-[0_2px_4px_rgba(0,0,0,0.6)]">
            <div className="w-1 h-4 bg-amber-200 rounded-full" />
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "LED Ring",
        label: "LED Ring",
        description: "A knob encircled by a glowing LED indicator ring.",
        defaultWidth: 80,
        defaultHeight: 80,
        preview: (
          <div className="w-12 h-12 rounded-full bg-app-base border-2 border-app-main/70 flex items-center justify-center shadow-[0_0_8px_rgba(168,85,247,0.6)]">
            <div className="w-7 h-7 rounded-full bg-app-surface border border-app-border flex items-start justify-center pt-1">
              <div className="w-0.5 h-2 bg-app-main rounded-full" />
            </div>
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "Glass",
        label: "Glass Knob",
        description: "A translucent frosted-glass knob with soft highlights.",
        defaultWidth: 64,
        defaultHeight: 64,
        preview: (
          <div className="w-12 h-12 rounded-full bg-white/10 border border-white/30 backdrop-blur-sm flex items-start justify-center pt-1 shadow-[inset_0_2px_6px_rgba(255,255,255,0.25),0_2px_6px_rgba(0,0,0,0.4)]">
            <div className="w-1 h-3 bg-white/70 rounded-full" />
          </div>
        ),
      },
      {
        type: "Knob",
        variant: "Jog Wheel",
        label: "Jog Wheel",
        description: "A large DJ-style jog wheel for scrubbing and scratching.",
        defaultWidth: 80,
        defaultHeight: 80,
        preview: (
          <div className="w-12 h-12 rounded-full bg-linear-to-br from-neutral-700 to-neutral-900 border-2 border-neutral-600 flex items-center justify-center shadow-[inset_0_2px_6px_rgba(0,0,0,0.6)]">
            <div className="w-6 h-6 rounded-full bg-neutral-800 border border-neutral-600 flex items-start justify-center pt-0.5">
              <div className="w-1 h-1.5 bg-app-main rounded-full" />
            </div>
          </div>
        ),
      },
    ],
  },
  {
    name: "Sliders",
    icon: SlidersHorizontal,
    variants: [
      {
        type: "Slider",
        variant: "Blank",
        label: "Blank Slider",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 32,
        defaultHeight: 120,
        preview: (
          <div className="w-6 h-20 bg-zinc-800 rounded border border-zinc-600 relative">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-3 bg-zinc-600 rounded-sm border border-zinc-500" />
          </div>
        ),
      },
      {
        type: "Slider",
        variant: "Bipole",
        label: "Bipole Fader",
        description: "A fader that starts at the center and moves up/down or left/right.",
        defaultWidth: 32,
        defaultHeight: 120,
        preview: (
          <div className="w-6 h-20 bg-app-base rounded border border-app-border relative overflow-hidden flex flex-col justify-center">
            <div className="absolute top-1/2 left-0 right-0 h-px bg-white/20" />
            <div className="w-full h-1/4 bg-app-main/50" />
            <div className="absolute top-[35%] left-1/2 -translate-x-1/2 w-8 h-3 bg-gray-400 rounded shadow" />
          </div>
        ),
      },
      {
        type: "Slider",
        variant: "Modernism",
        label: "Modernism",
        defaultWidth: 32,
        defaultHeight: 120,
        preview: (
          <div className="w-6 h-20 bg-app-surface rounded-full border border-app-border relative">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-4 bg-gray-400 rounded shadow" />
          </div>
        ),
      },
      {
        type: "Slider",
        variant: "Japandi",
        label: "Japandi",
        defaultWidth: 16,
        defaultHeight: 120,
        preview: (
          <div className="w-2 h-20 bg-app-surface-hover rounded-full relative mx-auto">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 bg-app-main text-app-base rounded-full shadow" />
          </div>
        ),
      },
      {
        type: "Slider",
        variant: "Contemporary Luxury Minimalism",
        label: "Contemp. Luxury",
        defaultWidth: 40,
        defaultHeight: 120,
        preview: (
          <div className="w-8 h-20 bg-app-surface rounded-[10px] shadow-[inset_2px_2px_4px_rgba(0,0,0,0.6),inset_-2px_-2px_4px_rgba(255,255,255,0.05)] relative">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 bg-app-surface rounded-[8px] shadow-[2px_2px_4px_rgba(0,0,0,0.5),-1px_-1px_2px_rgba(255,255,255,0.1)] flex items-center justify-center">
              <div className="w-2 h-0.5 bg-gray-500 rounded-full" />
            </div>
          </div>
        ),
      },
      {
        type: "Slider",
        variant: "Bauhaus",
        label: "Bauhaus",
        defaultWidth: 32,
        defaultHeight: 120,
        preview: (
          <div className="w-6 h-20 bg-black border-2 border-white relative">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-3 bg-white" />
          </div>
        ),
      },
      {
        type: "Slider",
        variant: "Channel Fader",
        label: "Channel Fader",
        description: "A long-throw mixing-console fader with a weighted cap.",
        defaultWidth: 40,
        defaultHeight: 160,
        preview: (
          <div className="w-6 h-20 bg-app-base rounded border border-app-border relative flex justify-center">
            <div className="absolute top-2 bottom-2 w-0.5 bg-white/20" />
            <div className="absolute top-[40%] left-1/2 -translate-x-1/2 w-8 h-4 bg-linear-to-b from-gray-300 to-gray-600 rounded-sm border border-black/30 shadow" />
          </div>
        ),
      },
      {
        type: "Slider",
        variant: "LED Slider",
        label: "LED Slider",
        description: "A fader with an illuminated track fill and glowing cap.",
        defaultWidth: 32,
        defaultHeight: 120,
        preview: (
          <div className="w-6 h-20 bg-app-base rounded-full border border-app-border relative overflow-hidden flex flex-col justify-end">
            <div className="w-full h-1/2 bg-app-main/60" />
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-7 h-2 bg-app-main rounded-full shadow-[0_0_6px_rgba(168,85,247,0.9)]" />
          </div>
        ),
      },
      {
        type: "Slider",
        variant: "Mod Wheel",
        label: "Mod Wheel",
        description: "A MIDI-style modulation wheel with a ridged thumb grip.",
        defaultWidth: 32,
        defaultHeight: 120,
        preview: (
          <div className="w-6 h-20 bg-neutral-900 rounded-md border border-app-border relative overflow-hidden flex flex-col justify-center gap-1 py-1">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="w-full h-px bg-white/10" />
            ))}
            <div className="absolute left-0 right-0 top-2/3 h-4 bg-linear-to-b from-neutral-500 to-neutral-700 -translate-y-1/2 shadow" />
          </div>
        ),
      },
      {
        type: "Slider",
        variant: "Pitch Wheel",
        label: "Pitch Wheel",
        description: "A spring-loaded pitch-bend wheel centered at rest.",
        defaultWidth: 32,
        defaultHeight: 120,
        preview: (
          <div className="w-6 h-20 bg-neutral-900 rounded-md border border-app-border relative overflow-hidden flex flex-col justify-center">
            <div className="absolute top-1/2 left-0 right-0 h-px bg-app-main/60" />
            <div className="absolute left-0 right-0 top-1/2 h-4 bg-linear-to-b from-neutral-500 to-neutral-700 -translate-y-1/2 shadow" />
          </div>
        ),
      }
    ],
  },
  {
    name: "Buttons",
    icon: MousePointer2,
    variants: [
      {
        type: "Button",
        variant: "Blank",
        label: "Blank Button",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 100,
        defaultHeight: 40,
        preview: (
          <div className="px-4 py-2 bg-zinc-700 border border-zinc-600 rounded text-xs text-zinc-400 font-medium w-full text-center">
            Button
          </div>
        ),
      },
      {
        type: "Button",
        variant: "Functionalism",
        label: "Functionalism",
        defaultWidth: 100,
        defaultHeight: 40,
        preview: (
          <div className="px-4 py-2 btn-3d rounded text-xs text-white font-medium shadow w-full text-center">
            Button
          </div>
        ),
      },
      {
        type: "Button",
        variant: "Soft Minimalism",
        label: "Soft Minimalism",
        defaultWidth: 100,
        defaultHeight: 40,
        preview: (
          <div className="px-4 py-2 bg-transparent border border-app-main rounded text-xs text-app-main font-medium w-full text-center">
            Button
          </div>
        ),
      },
      {
        type: "Button",
        variant: "Neumorphic",
        label: "Neumorphic",
        defaultWidth: 100,
        defaultHeight: 40,
        preview: (
          <div className="px-4 py-2 bg-app-surface rounded-[8px] text-xs text-app-main font-medium shadow-[4px_4px_8px_rgba(0,0,0,0.5),-2px_-2px_4px_rgba(255,255,255,0.05)] w-full text-center">
            Button
          </div>
        ),
      },
      {
        type: "Button",
        variant: "International Style",
        label: "International Style",
        defaultWidth: 100,
        defaultHeight: 40,
        preview: (
          <div className="px-4 py-2 bg-white border-[3px] border-black text-xs text-black font-bold uppercase w-full text-center shadow-[3px_3px_0_0_#000]">
            BTN
          </div>
        ),
      },
      {
        type: "Button",
        variant: "Drum Pad",
        label: "Drum Pad",
        description: "A large touch-sensitive pad for triggering sounds or events.",
        defaultWidth: 80,
        defaultHeight: 80,
        preview: (
          <div className="w-16 h-16 bg-app-surface border-2 border-app-border rounded-lg shadow-[inset_0_4px_10px_rgba(255,255,255,0.1),0_8px_15px_rgba(0,0,0,0.5)] flex items-center justify-center p-1.5">
             <div className="w-full h-full bg-white/5 rounded-md" />
          </div>
        )
      },
      {
        type: "Button",
        variant: "LED Push",
        label: "LED Push",
        description: "An illuminated momentary push button with an LED glow.",
        defaultWidth: 100,
        defaultHeight: 40,
        preview: (
          <div className="px-4 py-2 bg-app-main/20 border border-app-main rounded text-xs text-app-main font-medium w-full text-center shadow-[0_0_8px_rgba(168,85,247,0.5),inset_0_0_6px_rgba(168,85,247,0.4)]">
            PUSH
          </div>
        ),
      },
      {
        type: "Button",
        variant: "Chrome",
        label: "Chrome Button",
        description: "A polished chrome button with a reflective metallic sheen.",
        defaultWidth: 100,
        defaultHeight: 40,
        preview: (
          <div className="px-4 py-2 bg-linear-to-b from-white via-gray-300 to-gray-500 border border-gray-400 rounded text-xs text-gray-800 font-semibold w-full text-center shadow-[inset_0_1px_1px_rgba(255,255,255,0.9),0_2px_4px_rgba(0,0,0,0.5)]">
            Button
          </div>
        )
      }
    ],
  },
  {
    name: "Toggles",
    icon: ToggleLeft,
    variants: [
      {
        type: "Toggle",
        variant: "Blank",
        label: "Blank Toggle",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 48,
        defaultHeight: 24,
        preview: (
          <div className="w-12 h-6 bg-zinc-800 border border-zinc-600 rounded-full relative">
            <div className="absolute top-1 left-1 w-4 h-4 bg-zinc-500 rounded-full" />
          </div>
        ),
      },
      {
        type: "Toggle",
        variant: "Streamline Moderne",
        label: "Streamline Moderne",
        defaultWidth: 48,
        defaultHeight: 24,
        preview: (
          <div className="w-12 h-6 bg-app-surface neu-panel-inset border border-app-border rounded-full relative">
            <div className="absolute top-1 right-1 w-4 h-4 bg-white rounded-full shadow" />
          </div>
        ),
      },
      {
        type: "Toggle",
        variant: "Neo-minimalism",
        label: "Neo-minimalism",
        defaultWidth: 24,
        defaultHeight: 24,
        preview: (
          <div className="w-6 h-6 bg-app-surface neu-panel-inset rounded border border-app-main flex items-center justify-center">
            <div
              className="w-3 h-3 bg-white"
              style={{
                clipPath:
                  "polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%)",
              }}
            />
          </div>
        ),
      },
      {
        type: "Toggle",
        variant: "Brutalist",
        label: "Brutalist",
        defaultWidth: 48,
        defaultHeight: 24,
        preview: (
          <div className="w-12 h-6 bg-black border-2 border-white relative flex">
            <div className="w-1/2 h-full bg-white" />
            <div className="w-1/2 h-full bg-black" />
          </div>
        ),
      },
      {
        type: "Toggle",
        variant: "Rocker",
        label: "Rocker Switch",
        description: "A two-position rocker switch that pivots on a center axis.",
        defaultWidth: 48,
        defaultHeight: 24,
        preview: (
          <div className="w-12 h-6 bg-app-surface border border-app-border rounded-sm relative flex overflow-hidden shadow-inner">
            <div className="w-1/2 h-full bg-linear-to-b from-gray-400 to-gray-600 shadow-[inset_-2px_0_3px_rgba(0,0,0,0.4)]" />
            <div className="w-1/2 h-full bg-linear-to-b from-gray-600 to-gray-800" />
          </div>
        ),
      },
      {
        type: "Toggle",
        variant: "Lever",
        label: "Lever Switch",
        description: "A flip-style lever toggle switch on a mounting base.",
        defaultWidth: 48,
        defaultHeight: 24,
        preview: (
          <div className="w-12 h-6 bg-app-surface border border-app-border rounded-sm relative flex items-center justify-center shadow-inner">
            <div className="w-4 h-4 bg-linear-to-b from-gray-300 to-gray-500 rounded-t-full origin-bottom rotate-[25deg] shadow" />
          </div>
        ),
      },
    ],
  },
  {
    name: "Display",
    icon: LayoutGrid,
    variants: [
      {
        type: "Label",
        variant: "Blank",
        label: "Blank Label",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 120,
        defaultHeight: 32,
        preview: (
          <div className="text-zinc-400 text-xs font-sans border border-dashed border-zinc-600 px-2 py-0.5 rounded">
            Label
          </div>
        ),
      },
      {
        type: "Label",
        variant: "Scandinavian Modern",
        label: "Scandinavian",
        defaultWidth: 80,
        defaultHeight: 24,
        preview: (
          <div className="text-app-main text-xs font-sans">Label Text</div>
        ),
      },
      {
        type: "Label",
        variant: "Retrofuturism",
        label: "Retrofuturism",
        defaultWidth: 80,
        defaultHeight: 24,
        preview: (
          <div className="text-green-400 text-[10px] font-mono tracking-widest uppercase">SYS_RDY</div>
        ),
      },
      {
        type: "Label",
        variant: "LCD",
        label: "LCD",
        description: "A backlit LCD-style numeric / text readout.",
        defaultWidth: 120,
        defaultHeight: 40,
        preview: (
          <div className="px-2 py-1 bg-[#0a2a1a] border border-green-900 rounded text-green-400 text-[10px] font-mono tracking-widest shadow-[inset_0_0_6px_rgba(0,0,0,0.6)]">
            128.0
          </div>
        ),
      },
      {
        type: "Select",
        variant: "Blank",
        label: "Blank Select",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 140,
        defaultHeight: 36,
        preview: (
          <div className="w-full px-2 py-1 bg-zinc-700 border border-zinc-600 rounded text-xs text-zinc-400 flex justify-between items-center">
            <span>Select...</span>
            <ChevronDown className="w-3 h-3" />
          </div>
        ),
      },
      {
        type: "Select",
        variant: "Mid-century Modern",
        label: "Mid-century",
        defaultWidth: 120,
        defaultHeight: 32,
        preview: (
          <div className="w-full px-2 py-1 bg-app-surface border border-app-border rounded text-xs text-app-muted flex justify-between items-center">
            <span>Select...</span>
            <ChevronDown className="w-3 h-3" />
          </div>
        ),
      },
      {
        type: "Select",
        variant: "Swiss Style",
        label: "Swiss Style",
        defaultWidth: 120,
        defaultHeight: 32,
        preview: (
          <div className="w-full px-2 py-1 bg-white border-2 border-black text-xs text-black font-bold uppercase flex justify-between items-center shadow-[3px_3px_0_0_#000]">
            <span>CHOOSE</span>
            <div className="w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[6px] border-t-black" />
          </div>
        ),
      },
      {
        type: "Select",
        variant: "Segmented",
        label: "Segmented",
        description: "A segmented multi-option selector (button group).",
        defaultWidth: 160,
        defaultHeight: 36,
        preview: (
          <div className="flex w-full rounded overflow-hidden border border-app-border text-[9px]">
            <div className="flex-1 px-1 py-1 bg-app-main text-app-base text-center">A</div>
            <div className="flex-1 px-1 py-1 bg-app-surface text-app-muted text-center border-l border-app-border">B</div>
            <div className="flex-1 px-1 py-1 bg-app-surface text-app-muted text-center border-l border-app-border">C</div>
          </div>
        ),
      },
    ],
  },
  {
    name: "Waveforms",
    icon: Activity,
    variants: [
      {
        type: "Waveform",
        variant: "Blank",
        label: "Blank Waveform",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 120,
        defaultHeight: 60,
        preview: (
          <div className="w-16 h-8 bg-zinc-800 border border-zinc-600 rounded flex items-center justify-center overflow-hidden">
            <div className="w-full h-px bg-zinc-600" />
          </div>
        ),
      },
      {
        type: "Waveform",
        variant: "Oscilloscope",
        label: "Oscilloscope",
        description: "Visualizes an audio waveform or LFO signal in real-time.",
        defaultWidth: 200,
        defaultHeight: 100,
        preview: (
          <div className="w-16 h-8 bg-black border border-green-500/50 rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-green-500 opacity-80" viewBox="0 0 100 50" preserveAspectRatio="none">
              <path d="M0,25 Q12.5,0 25,25 T50,25 T75,25 T100,25" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
        ),
      },
      {
        type: "Waveform",
        variant: "Modern",
        label: "Modern",
        defaultWidth: 200,
        defaultHeight: 100,
        preview: (
          <div className="w-16 h-8 bg-app-base border border-app-border rounded flex items-center justify-center overflow-hidden gap-0.5 px-1">
            {[1, 3, 5, 2, 4, 6, 3, 2, 1, 4].map((h, i) => (
              <div key={i} className="flex-1 bg-app-main text-app-base rounded-full" style={{ height: `${h * 15}%` }} />
            ))}
          </div>
        ),
      },
      {
        type: "Waveform",
        variant: "LFO Sine",
        label: "LFO Sine",
        description: "A sine LFO shape for smooth cyclic modulation.",
        defaultWidth: 120,
        defaultHeight: 60,
        preview: (
          <div className="w-16 h-8 bg-app-base border border-app-border rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-app-main" viewBox="0 0 100 50" preserveAspectRatio="none">
              <path d="M0,25 Q12.5,0 25,25 T50,25 T75,25 T100,25" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
        ),
      },
      {
        type: "Waveform",
        variant: "LFO Triangle",
        label: "LFO Triangle",
        description: "A triangle LFO shape with linear ramps.",
        defaultWidth: 120,
        defaultHeight: 60,
        preview: (
          <div className="w-16 h-8 bg-app-base border border-app-border rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-app-main" viewBox="0 0 100 50" preserveAspectRatio="none">
              <path d="M0,45 L25,5 L50,45 L75,5 L100,45" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
        ),
      },
      {
        type: "Waveform",
        variant: "LFO Saw",
        label: "LFO Saw",
        description: "A sawtooth LFO shape that ramps up then resets.",
        defaultWidth: 120,
        defaultHeight: 60,
        preview: (
          <div className="w-16 h-8 bg-app-base border border-app-border rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-app-main" viewBox="0 0 100 50" preserveAspectRatio="none">
              <path d="M0,45 L48,5 L48,45 L96,5 L96,45 L100,45" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
        ),
      },
      {
        type: "Waveform",
        variant: "LFO Square",
        label: "LFO Square",
        description: "A square LFO shape for on/off gate modulation.",
        defaultWidth: 120,
        defaultHeight: 60,
        preview: (
          <div className="w-16 h-8 bg-app-base border border-app-border rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-app-main" viewBox="0 0 100 50" preserveAspectRatio="none">
              <path d="M0,45 L0,5 L25,5 L25,45 L50,45 L50,5 L75,5 L75,45 L100,45" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
        ),
      },
      {
        type: "Waveform",
        variant: "LFO S&H",
        label: "LFO S&H",
        description: "A sample-and-hold LFO shape with stepped random levels.",
        defaultWidth: 120,
        defaultHeight: 60,
        preview: (
          <div className="w-16 h-8 bg-app-base border border-app-border rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-app-main" viewBox="0 0 100 50" preserveAspectRatio="none">
              <path d="M0,30 L20,30 L20,10 L40,10 L40,40 L60,40 L60,20 L80,20 L80,35 L100,35" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
        ),
      }
    ]
  },
  {
    name: "Meters",
    icon: BarChart2,
    variants: [
      {
        type: "Meter",
        variant: "Blank",
        label: "Blank Meter",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 32,
        defaultHeight: 120,
        preview: (
          <div className="w-4 h-16 bg-zinc-800 border border-zinc-600 rounded-sm relative overflow-hidden flex flex-col justify-end">
            <div className="w-full h-1/3 bg-zinc-600" />
          </div>
        ),
      },
      {
        type: "Meter",
        variant: "VU Meter",
        label: "VU Meter",
        description: "An analog-style needle meter for monitoring volume levels.",
        defaultWidth: 120,
        defaultHeight: 60,
        preview: (
          <div className="w-16 h-8 bg-[#fdf5e6] border-2 border-app-border rounded relative overflow-hidden flex flex-col pt-1">
             <div className="w-full h-1 flex gap-px px-1">
               <div className="flex-1 bg-black/20" />
               <div className="flex-1 bg-black/20" />
               <div className="flex-1 bg-black/20" />
               <div className="flex-1 bg-black/20" />
               <div className="flex-1 bg-red-500/50" />
             </div>
             <div className="w-0.5 h-10 bg-black absolute bottom-0 left-1/2 origin-bottom -rotate-[30deg]" />
          </div>
        )
      },
      {
        type: "Meter",
        variant: "LED Bar",
        label: "LED Bar",
        description: "A digital LED bar graph for monitoring signal levels.",
        defaultWidth: 32,
        defaultHeight: 120,
        preview: (
          <div className="w-4 h-16 bg-app-base border border-app-border p-0.5 flex flex-col gap-0.5">
            {[...Array(8)].map((_, i) => (
              <div key={i} className={`flex-1 ${i < 2 ? 'bg-red-500' : i < 4 ? 'bg-yellow-400' : 'bg-green-500'}`} style={{ opacity: i < 6 ? 1 : 0.2 }} />
            ))}
          </div>
        )
      },
      {
        type: "Meter",
        variant: "LED Segments",
        label: "LED Segments",
        description: "A segmented LED level meter built from discrete lit blocks.",
        defaultWidth: 32,
        defaultHeight: 120,
        preview: (
          <div className="w-4 h-16 bg-app-base border border-app-border p-0.5 flex flex-col gap-1">
            {[...Array(7)].map((_, i) => (
              <div key={i} className={`flex-1 rounded-sm ${i < 1 ? 'bg-red-500' : i < 3 ? 'bg-yellow-400' : 'bg-green-500'}`} style={{ opacity: i < 4 ? 1 : 0.25 }} />
            ))}
          </div>
        )
      }
    ]
  },
  {
    name: "XY Pads",
    icon: Move,
    variants: [
      {
        type: "XYPad",
        variant: "Blank",
        label: "Blank Pad",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 150,
        defaultHeight: 150,
        preview: (
          <div className="w-12 h-12 bg-zinc-800 border border-zinc-600 rounded relative">
            <div className="absolute top-1/2 left-1/2 w-2 h-2 bg-zinc-500 rounded-full -translate-x-1/2 -translate-y-1/2" />
          </div>
        )
      },
      {
        type: "XYPad",
        variant: "Kaoss",
        label: "Kaoss Pad",
        description: "A 2D touch pad to control X and Y parameters simultaneously.",
        defaultWidth: 150,
        defaultHeight: 150,
        preview: (
          <div className="w-12 h-12 bg-black border border-red-500/50 rounded relative">
            <div className="absolute top-0 bottom-0 left-1/3 w-px bg-red-500/30" />
            <div className="absolute left-0 right-0 top-1/2 h-px bg-red-500/30" />
            <div className="absolute top-1/2 left-1/3 w-2 h-2 bg-red-500 rounded-full -translate-x-1/2 -translate-y-1/2 shadow-[0_0_8px_rgba(239,68,68,1)]" />
          </div>
        )
      },
      {
        type: "XYPad",
        variant: "Crosshair",
        label: "Crosshair Pad",
        description: "A 2D control surface with a targeting crosshair and glowing node.",
        defaultWidth: 150,
        defaultHeight: 150,
        preview: (
          <div className="w-12 h-12 bg-app-base border border-app-main/50 rounded relative">
            <div className="absolute top-0 bottom-0 left-1/2 w-px bg-app-main/30" />
            <div className="absolute left-0 right-0 top-1/2 h-px bg-app-main/30" />
            <div className="absolute top-1/2 left-1/2 w-2 h-2 border-2 border-app-main rounded-full -translate-x-1/2 -translate-y-1/2 shadow-[0_0_6px_rgba(168,85,247,0.8)]" />
          </div>
        )
      }
    ]
  },
  {
    name: "Spatial / 3D",
    icon: Box,
    variants: [
      {
        type: "Spatial3D",
        variant: "Blank",
        label: "Blank Spatial",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 150,
        defaultHeight: 150,
        preview: (
          <div className="w-12 h-12 bg-zinc-800 border border-zinc-600 rounded-full relative flex items-center justify-center overflow-hidden">
            <div className="w-6 h-6 rounded-full border border-zinc-600 absolute" />
            <div className="w-1.5 h-1.5 bg-zinc-500 rounded-full" />
          </div>
        )
      },
      {
        type: "Spatial3D",
        variant: "Radar",
        label: "Radar",
        description: "A 3D spatial radar interface for positioning elements in space.",
        defaultWidth: 150,
        defaultHeight: 150,
        preview: (
          <div className="w-12 h-12 bg-app-base border border-green-500/30 rounded-full relative overflow-hidden flex items-center justify-center">
            <div className="w-8 h-8 rounded-full border border-green-500/30 absolute" />
            <div className="w-4 h-4 rounded-full border border-green-500/30 absolute" />
            <div className="absolute top-1/2 left-1/2 w-1/2 h-1/2 bg-linear-to-br from-green-500/40 to-transparent origin-top-left rotate-45" />
            <div className="w-1.5 h-1.5 bg-green-400 rounded-full absolute top-1/4 left-1/3 shadow-[0_0_4px_#4ade80]" />
          </div>
        )
      }
    ]
  },
  {
    name: "Shapers & Sequencers",
    icon: AudioWaveform,
    variants: [
      {
        type: "WaveShaper",
        variant: "Blank",
        label: "Blank Shaper",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 160,
        defaultHeight: 120,
        preview: (
          <div className="w-16 h-12 bg-zinc-800 border border-zinc-600 rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-zinc-600" viewBox="0 0 100 60" preserveAspectRatio="none">
              <path d="M0,55 L100,5" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
        ),
      },
      {
        type: "WaveShaper",
        variant: "Sine Fold",
        label: "Sine Fold",
        description: "A wavefolding shaper with a sine transfer curve.",
        defaultWidth: 160,
        defaultHeight: 120,
        preview: (
          <div className="w-16 h-12 bg-app-base border border-app-border rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-app-main" viewBox="0 0 100 60" preserveAspectRatio="none">
              <path d="M0,55 C15,55 20,5 32,30 C44,55 50,5 62,30 C74,55 82,5 100,5" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
        ),
      },
      {
        type: "WaveShaper",
        variant: "Tanh",
        label: "Tanh",
        description: "A smooth tanh saturation curve for soft clipping.",
        defaultWidth: 160,
        defaultHeight: 120,
        preview: (
          <div className="w-16 h-12 bg-app-base border border-app-border rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-app-main" viewBox="0 0 100 60" preserveAspectRatio="none">
              <path d="M0,52 C35,52 35,8 50,30 C65,52 65,8 100,8" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
        ),
      },
      {
        type: "WaveShaper",
        variant: "Hard Fold",
        label: "Hard Fold",
        description: "A hard wavefolding shaper with sharp fold points.",
        defaultWidth: 160,
        defaultHeight: 120,
        preview: (
          <div className="w-16 h-12 bg-app-base border border-app-border rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-app-main" viewBox="0 0 100 60" preserveAspectRatio="none">
              <path d="M0,55 L25,5 L50,55 L75,5 L100,55" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
        ),
      },
      {
        type: "WaveShaper",
        variant: "Tube Drive",
        label: "Tube Drive",
        description: "An asymmetric tube-style overdrive transfer curve.",
        defaultWidth: 160,
        defaultHeight: 120,
        preview: (
          <div className="w-16 h-12 bg-app-base border border-app-border rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-app-main" viewBox="0 0 100 60" preserveAspectRatio="none">
              <path d="M0,55 C45,55 25,15 100,8" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
        ),
      },
      {
        type: "Envelope",
        variant: "Blank",
        label: "Blank Envelope",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 200,
        defaultHeight: 120,
        preview: (
          <div className="w-16 h-12 bg-zinc-800 border border-zinc-600 rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-zinc-600" viewBox="0 0 100 60" preserveAspectRatio="none">
              <path d="M2,55 L98,55" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            </svg>
          </div>
        ),
      },
      {
        type: "Envelope",
        variant: "ADSR",
        label: "ADSR",
        description: "An attack / decay / sustain / release envelope editor.",
        defaultWidth: 200,
        defaultHeight: 120,
        preview: (
          <div className="w-16 h-12 bg-app-base border border-app-border rounded flex items-center justify-center overflow-hidden">
            <svg className="w-full h-full text-app-main" viewBox="0 0 100 60" preserveAspectRatio="none">
              <path d="M2,55 L20,5 L45,30 L70,30 L98,55" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            </svg>
          </div>
        ),
      },
      {
        type: "StepSequencer",
        variant: "Blank",
        label: "Blank Sequencer",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 240,
        defaultHeight: 120,
        preview: (
          <div className="w-16 h-12 bg-zinc-800 border border-zinc-600 rounded p-1 grid grid-cols-4 grid-rows-3 gap-1">
            {[...Array(12)].map((_, i) => (
              <div key={i} className="rounded-sm bg-zinc-700" />
            ))}
          </div>
        ),
      },
      {
        type: "StepSequencer",
        variant: "Grid",
        label: "Grid",
        description: "A grid step sequencer for programming patterns.",
        defaultWidth: 240,
        defaultHeight: 120,
        preview: (
          <div className="w-16 h-12 bg-black/40 border border-app-border rounded p-1 grid grid-cols-4 grid-rows-3 gap-1">
            {[...Array(12)].map((_, i) => (
              <div
                key={i}
                className={`rounded-sm ${[0, 5, 10, 7].includes(i) ? "bg-app-main" : "bg-app-surface-hover"}`}
              />
            ))}
          </div>
        ),
      },
      {
        type: "Keyboard",
        variant: "Blank",
        label: "Blank Keys",
        description: "Neutral starting template — customize everything via properties, params, skins & textures",
        defaultWidth: 240,
        defaultHeight: 80,
        preview: (
          <div className="w-16 h-8 bg-zinc-700 rounded border border-zinc-600 relative flex overflow-hidden">
            {[...Array(7)].map((_, i) => (
              <div key={i} className="flex-1 border-r border-zinc-600 last:border-r-0" />
            ))}
          </div>
        ),
      },
      {
        type: "Keyboard",
        variant: "Keys",
        label: "Keys",
        description: "A piano-key input strip for note entry.",
        defaultWidth: 240,
        defaultHeight: 80,
        preview: (
          <div className="w-16 h-8 bg-white rounded border border-app-border relative flex overflow-hidden">
            {[...Array(7)].map((_, i) => (
              <div key={i} className="flex-1 border-r border-gray-300 last:border-r-0" />
            ))}
            {[0, 1, 3, 4, 5].map((k) => (
              <div
                key={k}
                className="absolute top-0 h-2/3 w-1.5 bg-black"
                style={{ left: `${((k + 1) / 7) * 100}%`, transform: "translateX(-50%)" }}
              />
            ))}
          </div>
        ),
      },
    ],
  },
  {
    name: "Frames",
    icon: Square,
    variants: [
      // FILLED variants first (backplate looks — a surface behind controls).
      {
        type: "Frame",
        variant: "Backplate",
        label: "Backplate",
        description: "A plain filled backplate — a surface to place controls on.",
        defaultWidth: 220,
        defaultHeight: 160,
        preview: (
          <div className="w-16 h-10 rounded bg-app-surface border border-app-border" />
        ),
      },
      {
        type: "Frame",
        variant: "Plate",
        label: "Screw Plate",
        description: "A filled backplate with corner screw dots.",
        defaultWidth: 220,
        defaultHeight: 160,
        preview: (
          <div className="w-16 h-10 rounded bg-app-surface border border-app-border relative">
            {["top-0.5 left-0.5", "top-0.5 right-0.5", "bottom-0.5 left-0.5", "bottom-0.5 right-0.5"].map((pos) => (
              <div key={pos} className={`absolute ${pos} w-1 h-1 rounded-full bg-app-border`} />
            ))}
          </div>
        ),
      },
      {
        type: "Frame",
        variant: "Glass",
        label: "Glass Panel",
        description: "A translucent frosted panel with a soft top highlight.",
        defaultWidth: 220,
        defaultHeight: 160,
        preview: (
          <div className="w-16 h-10 rounded bg-white/10 border border-white/20 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1/3 bg-linear-to-b from-white/25 to-transparent" />
          </div>
        ),
      },
      {
        type: "Frame",
        variant: "Titled",
        label: "Titled Panel",
        description: "A backplate with a top title strip that shows the element label.",
        defaultWidth: 220,
        defaultHeight: 160,
        preview: (
          <div className="w-16 h-10 rounded bg-app-surface border border-app-border overflow-hidden flex flex-col">
            <div className="h-3 shrink-0 bg-app-surface-hover border-b border-app-border" />
            <div className="flex-1" />
          </div>
        ),
      },
      // HOLLOW variants after (frame looks — trim around things, transparent center).
      {
        type: "Frame",
        variant: "Border",
        label: "Border Frame",
        description: "A plain border ring with a transparent center.",
        defaultWidth: 220,
        defaultHeight: 160,
        preview: (
          <div className="w-16 h-10 rounded border border-app-border bg-transparent" />
        ),
      },
      {
        type: "Frame",
        variant: "Bezel",
        label: "Bezel Frame",
        description: "A double-border bezel with an inner inset shadow and transparent center.",
        defaultWidth: 220,
        defaultHeight: 160,
        preview: (
          <div className="w-16 h-10 rounded border-2 border-app-border bg-transparent shadow-[inset_0_0_0_2px_rgba(255,255,255,0.08)]" />
        ),
      },
    ],
  },
  {
    name: "Custom Code",
    icon: Code,
    variants: [] // We'll handle this dynamically
  },
  {
    name: "Saved Presets",
    icon: Save,
    variants: [] // We'll handle this dynamically
  },
  {
    name: "Arsenal",
    icon: Boxes,
    variants: [] // Fed dynamically from the global Arsenal palette (App state)
  }
];

import CollapsiblePanel from './CollapsiblePanel';

interface SidebarProps {
  onDragStart: (
    e: React.DragEvent,
    type: ElementType,
    defaultWidth: number,
    defaultHeight: number,
    variant?: string,
    customCode?: string,
    presetData?: any
  ) => void;
  isCategoriesOpen?: boolean;
  isExplorerOpen?: boolean;
  // Reusable custom modules now live in App state (autosaved to idb + server),
  // not sidebar-local localStorage — so they persist regardless of who made them.
  customModules?: CustomModule[];
  onAddCustomModule?: (name: string, code: string) => void;
  // Global Arsenal palette (saved image-face controls). Lives in App state,
  // hydrated from its own idb key — see src/lib/arsenal.ts. onRemoveArsenal
  // drops an entry (the delete-X on each Arsenal tile).
  arsenal?: ArsenalEntry[];
  onRemoveArsenal?: (id: string) => void;
}

export default function Sidebar({ onDragStart, isCategoriesOpen = true, isExplorerOpen = true, customModules = [], onAddCustomModule, arsenal = [], onRemoveArsenal }: SidebarProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>(CATEGORIES[0].name);
  // The palette (variants column) opens only when a rail icon is hovered,
  // focused, or clicked; it closes when the pointer leaves the sidebar.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // True while a variant tile is being dragged to the canvas. Collapsing the
  // palette mid-drag would remove the drag-source node and abort the HTML5
  // drag in some browsers, so the mouse-leave collapse is blocked while set.
  const draggingRef = React.useRef(false);

  // Custom Presets for standard elements
  const [customPresets, setCustomPresets] = useState<any[]>(() => {
    try {
      const saved = localStorage.getItem('vst-custom-presets');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Listen for preset updates from other components
  React.useEffect(() => {
    const handleStorage = () => {
      try {
        const saved = localStorage.getItem('vst-custom-presets');
        if (saved) setCustomPresets(JSON.parse(saved));
      } catch {}
    };
    window.addEventListener('vst-preset-saved', handleStorage);
    return () => window.removeEventListener('vst-preset-saved', handleStorage);
  }, []);

  const [newCodeInput, setNewCodeInput] = useState('');
  const [newCodeName, setNewCodeName] = useState('');

  const activeCategory = CATEGORIES.find(c => c.name === selectedCategory);

  const handleAddCustomCode = () => {
    if (!newCodeInput.trim() || !newCodeName.trim()) return;
    // Persist through App state (autosave + server) instead of sidebar-local
    // localStorage, so the module survives like the rest of the project.
    onAddCustomModule?.(newCodeName, newCodeInput);
    setNewCodeInput('');
    setNewCodeName('');
  };

  const getVariants = () => {
    if (activeCategory?.name === 'Custom Code') {
      // Render straight from the App-provided modules; preview is built from the
      // serialized customCode on the fly (the stored module carries no JSX).
      return customModules.map((m) => ({
        type: m.type as ElementType,
        variant: m.variant,
        label: m.label,
        defaultWidth: m.defaultWidth,
        defaultHeight: m.defaultHeight,
        customCode: m.customCode,
        // Carry the saved parameter schema so a dropped module restores its
        // editable params (presetData is spread onto the new element on drop).
        presetData:
          m.params && m.params.length ? { params: m.params } : undefined,
        preview: (
          <CustomCodeFrame
            el={{ id: "mod-" + (m.variant || "custom"), type: "CustomCode", customCode: m.customCode, params: m.params } as UIElement}
            isPreview={false}
          />
        ),
      })) as any;
    }

    if (activeCategory?.name === 'Saved Presets') {
      return customPresets.map(p => ({
        type: p.type,
        variant: p.variant,
        label: p.label || p.variant,
        defaultWidth: p.width || 100,
        defaultHeight: p.height || 100,
        presetData: p.presetData,
        preview: (
          <div className="text-[10px] text-app-muted border border-dashed border-app-border rounded p-2 text-center w-full break-all">
            {p.type}: {p.label || p.variant}
          </div>
        )
      })) as any;
    }

    if (activeCategory?.name === 'Arsenal') {
      // Each Arsenal entry becomes a drag tile whose presetData (faceSrc,
      // styleParams, colors — instance-agnostic) is spread whole on drop, so no
      // drag-contract change is needed. arsenalId marks the tile so ONLY these
      // tiles get the delete-X. Preview is the saved face image, or the type's
      // initial when no thumb was captured.
      return arsenal.map(entry => ({
        type: entry.type,
        variant: entry.name,
        label: entry.name,
        defaultWidth: entry.defaultWidth,
        defaultHeight: entry.defaultHeight,
        presetData: entry.presetData,
        arsenalId: entry.id,
        preview: entry.previewUrl ? (
          <img
            src={entry.previewUrl}
            alt=""
            className="max-w-full max-h-full object-contain"
          />
        ) : (
          <span className="text-lg font-bold text-app-muted uppercase">
            {entry.type.charAt(0)}
          </span>
        )
      })) as any;
    }

    // Mix in custom presets that belong to this category's ElementType
    const categoryVariants = activeCategory?.variants || [];
    if (activeCategory && categoryVariants.length > 0) {
      const categoryType = categoryVariants[0].type;
      const relevantPresets = customPresets.filter(p => p.type === categoryType).map(p => ({
        type: p.type,
        variant: p.variant,
        label: p.label || p.variant,
        defaultWidth: p.width || 100,
        defaultHeight: p.height || 100,
        presetData: p.presetData, // Pass the whole object payload for drop logic
        preview: (
          <div className="text-[10px] text-app-muted border border-dashed border-app-border rounded p-2 text-center w-full break-all">
            Custom Preset: {p.label || p.variant}
          </div>
        )
      }));
      return [...categoryVariants, ...relevantPresets] as any;
    }
    
    return categoryVariants;
  };

  const currentVariants = getVariants();

  return (
    <div
      className="flex h-full min-h-0 bg-app-base z-10 relative"
      onMouseLeave={() => {
        if (!draggingRef.current) setPaletteOpen(false);
      }}
    >
      {/* Icon rail: one button per category, icons only, no visible titles.
          The buttons split the rail's full height between them, so they size
          themselves to fill the column. Hovering (or keyboard-focusing) an
          icon reveals its name chip and opens that category's palette. */}
      <div className={`flex flex-col shrink-0 min-h-0 border-r border-app-border transition-all duration-300 ${isCategoriesOpen ? 'w-16' : 'w-0 border-r-0 overflow-hidden'}`}>
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1 p-1">
          {CATEGORIES.map((category) => {
            const Icon = category.icon;
            const isSelected = selectedCategory === category.name && paletteOpen;
            const activate = () => {
              setSelectedCategory(category.name);
              setPaletteOpen(true);
            };
            return (
              <button
                key={category.name}
                type="button"
                aria-label={category.name}
                aria-expanded={isSelected}
                onMouseEnter={activate}
                onFocus={activate}
                onClick={activate}
                className={`group relative flex-1 min-h-10 w-full rounded-2xl flex items-center justify-center transition-colors ${isSelected ? 'bg-app-surface text-white' : 'text-app-muted hover:bg-app-surface-hover hover:text-white'}`}
              >
                <Icon className="w-7 h-7" />
                <span className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded-lg bg-app-surface border border-app-border text-app-main text-xs font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 pointer-events-none transition-opacity z-50 shadow-[0_4px_16px_rgba(0,0,0,0.5)]">
                  {category.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={`flex flex-col bg-app-base border-r border-app-border shrink-0 min-h-0 transition-all duration-300 ${paletteOpen && isExplorerOpen ? 'w-52 md:w-64' : 'w-0 border-r-0 overflow-hidden'}`}>
        {activeCategory && (
          <CollapsiblePanel 
            title={activeCategory.name} 
            defaultOpen={true} 
            flex1={true}
            extraHeader={<activeCategory.icon className="w-4 h-4 text-app-muted shrink-0" />}
          >
            {activeCategory.name === 'Custom Code' && (
              <div className="p-3 border-b border-app-border bg-app-surface flex flex-col gap-2">
                <input
                  type="text"
                  placeholder="Component Name"
                  className="bg-app-base border border-app-border p-1.5 text-xs rounded text-white"
                  value={newCodeName}
                  onChange={e => setNewCodeName(e.target.value)}
                />
                <textarea
                  placeholder="HTML/JSX code..."
                  className="bg-app-base border border-app-border p-1.5 text-xs rounded text-white h-24 font-mono"
                  value={newCodeInput}
                  onChange={e => setNewCodeInput(e.target.value)}
                />
                <button
                  onClick={handleAddCustomCode}
                  className="bg-app-main text-app-base px-2 py-1 text-xs rounded font-medium hover:bg-white transition-colors"
                >
                  Create Custom Element
                </button>
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-3 grid grid-cols-2 gap-2 bg-black/20 shadow-[inset_0_4px_12px_rgba(0,0,0,0.5)]">
              {currentVariants.map((variant, index) => (
                <div
                  key={`${variant.type}-${variant.variant}-${index}`}
                  draggable
                  onDragStart={(e) => {
                    draggingRef.current = true;
                    onDragStart(
                      e,
                      variant.type,
                      variant.defaultWidth,
                      variant.defaultHeight,
                      variant.variant,
                      (variant as any).customCode,
                      (variant as any).presetData
                    );
                  }}
                  onDragEnd={() => {
                    draggingRef.current = false;
                    setPaletteOpen(false);
                  }}
                  className="flex flex-col items-center justify-between p-3 bg-app-surface border border-app-border rounded cursor-grab hover:bg-app-surface-hover hover:border-app-main/50 hover:shadow-[0_4px_12px_rgba(0,0,0,0.5)] transition-all group relative"
                  title={variant.description || `${variant.label} ${variant.type}`}
                >
                  {/* Delete-X — Arsenal tiles ONLY (marked by arsenalId). Small,
                      hover-revealed; stops propagation so it never starts a drag. */}
                  {(variant as any).arsenalId && onRemoveArsenal && (
                    <button
                      type="button"
                      aria-label="Remove from arsenal"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveArsenal((variant as any).arsenalId);
                      }}
                      className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 p-0.5 rounded bg-app-base/80 text-app-muted hover:text-red-400 transition-opacity z-10"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                  <div className="flex-1 flex items-center justify-center mb-3 group-hover:scale-105 transition-transform overflow-hidden w-full h-full">
                    {variant.preview}
                  </div>
                  <span className="text-[10px] text-app-muted text-center uppercase tracking-wider overflow-hidden text-ellipsis w-full">
                    {variant.label}
                  </span>
                </div>
              ))}
            </div>
          </CollapsiblePanel>
        )}
      </div>
    </div>
  );
}
