export const getArchetype = (v: string | undefined) => {
  switch (v) {
    case 'Swiss Style':
    case 'International Style':
    case 'Bauhaus':
    case 'Brutalist':
    case 'Functionalism':
      return 'Brutalist';
    case 'Apple-esque Minimalism':
    case 'Contemporary Luxury Minimalism':
    case 'Neumorphic':
      return 'Neumorphic';
    case 'Space Age Design':
    case 'Retrofuturism':
    case 'Mid-century Modern':
    case 'Aluminum':
    case 'Chrome':
    case 'Channel Fader':
    case 'Rocker':
    case '3D':
      return '3D';
    case 'Japandi':
    case 'Soft Minimalism':
    case 'Scandinavian Modern':
    case 'Minimalist':
    case 'Neo-minimalism':
    case 'Thin':
      return 'Minimal';
    case 'Skeuomorphic':
    case 'Streamline Moderne':
    case 'Vintage':
    case 'Lever':
    case 'Classic':
      return 'Classic';
    case 'Morphogenetic Design':
    case 'CellShaded':
      return 'CellShaded';
    case 'LED Ring':
    case 'LED Push':
    case 'LED Slider':
    case 'LED Segments':
    case 'Crosshair':
    case 'Glass':
    case 'Modernism':
    default:
      return 'Modern';
  }
};

export const getDefaultColors = (variant: string | undefined) => {
  const archetype = getArchetype(variant);
  return {
    baseColor: archetype === 'CellShaded' ? '#facc15' : archetype === 'Brutalist' ? '#000000' : '#121116',
    activeColor: archetype === 'CellShaded' ? '#22d3ee' : archetype === 'Brutalist' ? '#ffffff' : '#a855f7',
    textColor: archetype === 'CellShaded' ? '#000000' : archetype === 'Brutalist' ? '#ffffff' : '#f8fafc',
    borderColor: archetype === 'CellShaded' ? '#000000' : archetype === 'Brutalist' ? '#ffffff' : '#221f2e',
  };
};
