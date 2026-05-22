import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Search, Database, Heart, Clock, Play, Download, Trash2, 
  Plus, FolderPlus, Grid, List, Filter, ChevronDown, Music, 
  Upload, MoreVertical, Star, Calendar, ArrowUpDown, Tag, Folder, UploadCloud,
  LayoutGrid, List as ListIcon, SlidersHorizontal, Activity
} from 'lucide-react';
import { Section } from '../components/ui/Section';

export const LibraryView: React.FC<{ onSwitchTab?: (tab: string) => void }> = ({ onSwitchTab }) => {
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [searchQuery, setSearchQuery] = useState('');
   const [folders, setFolders] = useState(['Project Alpha', 'Techno Loops', 'Field Recordings']);
   const [activeFolder, setActiveFolder] = useState('Project Alpha');
   const [onlyFavorites, setOnlyFavorites] = useState(false);
   const [sortBy, setSortBy] = useState<'name' | 'len' | 'date' | 'plays'>('name');
   const [newFolderCount, setNewFolderCount] = useState(1);
  
   const [songs, setSongs] = useState([
    { id: 1, name: 'Deep_Atmosphere_01', type: 'Ambient', length: '0:45', date: '2024-03-15', plays: 12, favorite: true },
    { id: 2, name: 'Cyberpunk_Lead_V3', type: 'Synth', length: '0:12', date: '2024-03-14', plays: 45, favorite: false },
    { id: 3, name: 'Rhythm_Glitch_Loop', type: 'Percussion', length: '0:04', date: '2024-03-10', plays: 128, favorite: true },
    { id: 4, name: 'Basement_Kick_Analog', type: 'Drums', length: '0:01', date: '2024-02-28', plays: 8, favorite: false },
  ]);

   const filteredSongs = useMemo(() => {
      const normalizedQuery = searchQuery.trim().toLowerCase();
      const matches = songs.filter((song) => {
         if (onlyFavorites && !song.favorite) {
            return false;
         }
         if (!normalizedQuery) {
            return true;
         }
         return (
            song.name.toLowerCase().includes(normalizedQuery) ||
            song.type.toLowerCase().includes(normalizedQuery)
         );
      });

      const sorted = [...matches];
      sorted.sort((a, b) => {
         if (sortBy === 'plays') return b.plays - a.plays;
         if (sortBy === 'date') return b.date.localeCompare(a.date);
         if (sortBy === 'len') return b.length.localeCompare(a.length);
         return a.name.localeCompare(b.name);
      });
      return sorted;
   }, [songs, searchQuery, onlyFavorites, sortBy]);

   const toggleFavorite = (songId: number) => {
      setSongs((prev) => prev.map((song) => (song.id === songId ? { ...song, favorite: !song.favorite } : song)));
   };

   const recordPlay = (songId: number) => {
      setSongs((prev) => prev.map((song) => (song.id === songId ? { ...song, plays: song.plays + 1 } : song)));
   };

   const removeSong = (songId: number) => {
      setSongs((prev) => prev.filter((song) => song.id !== songId));
   };

  return (
    <div className="flex flex-col gap-2 h-full text-[11px] pb-4 px-2 pt-2">
      
      <Section title="COLLECTIONS / FOLDERS" icon={Folder} defaultOpen={true} rightNode={
        <div className="flex items-center gap-1">
                <button
                   className="p-1 hover:bg-white/10 rounded group"
                   onClick={() => {
                      const folderName = `New Collection ${newFolderCount}`;
                      setNewFolderCount((prev) => prev + 1);
                      setFolders((prev) => [...prev, folderName]);
                      setActiveFolder(folderName);
                   }}
                ><FolderPlus className="w-3 h-3 text-zinc-500 group-hover:text-white" /></button>
                <button className="p-1 hover:bg-white/10 rounded group" onClick={() => onSwitchTab?.('create')}><UploadCloud className="w-3 h-3 text-zinc-500 group-hover:text-white" /></button>
        </div>
      }>
         <div className="flex flex-col gap-1">
             {folders.map((folder, i) => (
                        <div key={i} className={`flex items-center justify-between p-1.5 rounded cursor-pointer group ${activeFolder === folder ? 'bg-white/10' : 'hover:bg-white/5'}`} onClick={() => setActiveFolder(folder)}>
                   <div className="flex items-center gap-2 overflow-hidden flex-1">
                      <Music className="w-3 h-3 text-purple-500/60 flex-shrink-0" />
                      <span className="text-zinc-300 truncate">{folder}</span>
                   </div>
                   <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <span className="text-[8px] font-mono text-zinc-600">12 items</span>
                                 <button
                                    className="p-0.5 hover:text-red-500"
                                    onClick={(event) => {
                                       event.stopPropagation();
                                       setFolders((prev) => {
                                          const next = prev.filter((name) => name !== folder);
                                          if (!next.includes(activeFolder)) {
                                             setActiveFolder(next[0] ?? '');
                                          }
                                          return next;
                                       });
                                    }}
                                 ><Trash2 className="w-2.5 h-2.5" /></button>
                   </div>
                </div>
             ))}
                   <button
                      className="w-full py-1.5 border border-dashed border-white/5 rounded text-zinc-600 hover:text-zinc-400 text-[9px] uppercase font-bold mt-1"
                      onClick={() => {
                         const folderName = `New Collection ${newFolderCount}`;
                         setNewFolderCount((prev) => prev + 1);
                         setFolders((prev) => [...prev, folderName]);
                         setActiveFolder(folderName);
                      }}
                   >
                + New Collection
             </button>
         </div>
      </Section>

      <Section 
        title="SONGS" 
        icon={Database} 
        defaultOpen={true} 
        resizable={true}
        rightNode={
          <div className="flex items-center gap-2">
             <button onClick={() => setViewMode('list')} className={`p-1 rounded ${viewMode === 'list' ? 'bg-white/10 text-white' : 'text-zinc-600'}`}><List className="w-3 h-3" /></button>
             <button onClick={() => setViewMode('grid')} className={`p-1 rounded ${viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-zinc-600'}`}><LayoutGrid className="w-3 h-3" /></button>
          </div>
        }
      >
         {/* Search & Global Filters */}
         <div className="flex flex-col gap-2 mb-3">
             <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600" />
                <input 
                  type="text" 
                  className="compact-input w-full pl-7" 
                  placeholder="SEARCH INDEX..." 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
             </div>
             
             <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
                <button className={`mono-tag flex items-center gap-1 whitespace-nowrap ${onlyFavorites ? '!bg-purple-600/20 !text-purple-300 border-purple-500/30' : '!bg-white/5 !text-zinc-400'}`} onClick={() => setOnlyFavorites((prev) => !prev)}>
                   <Star className="w-2 h-2 fill-current" /> FAVS
                </button>
                <button className="mono-tag !bg-white/5 !text-zinc-400 flex items-center gap-1 whitespace-nowrap" onClick={() => setSortBy('date')}>
                   <Clock className="w-2 h-2" /> RECIENTS
                </button>
                <button className="mono-tag !bg-white/5 !text-zinc-400 flex items-center gap-1 whitespace-nowrap" onClick={() => setSearchQuery('loop')}>
                   <Tag className="w-2 h-2" /> LOOPS
                </button>
                <button className="mono-tag !bg-white/5 !text-zinc-400 flex items-center gap-1 whitespace-nowrap" onClick={() => setSearchQuery('')}>
                   <Filter className="w-2 h-2" /> TOOLS
                </button>
             </div>
         </div>

         {/* Sorting Bar */}
         <div className="flex items-center justify-between px-1 mb-1 text-[8px] font-mono text-zinc-600 uppercase border-b border-white/5 pb-1">
            <button className="flex items-center gap-1 hover:text-zinc-300" onClick={() => setSortBy('name')}><ArrowUpDown className="w-2 h-2" /> NAME</button>
            <div className="flex gap-4">
               <button className="hover:text-zinc-300" onClick={() => setSortBy('len')}>LEN</button>
               <button className="hover:text-zinc-300" onClick={() => setSortBy('date')}>DATE</button>
               <button className="hover:text-zinc-300" onClick={() => setSortBy('plays')}>PLAYS</button>
            </div>
         </div>

         <div className={viewMode === 'list' ? "flex flex-col gap-1" : "grid grid-cols-2 gap-2"}>
            {filteredSongs.map((song) => (
              <div 
                key={song.id} 
                className={`hardware-card !p-0 group cursor-pointer transition-all hover:bg-white/[0.04]
                  ${viewMode === 'list' ? 'flex-row items-center border-white/5 p-1' : 'aspect-square flex-col'}`}
              >
                 {viewMode === 'grid' && (
                    <div className="flex-1 bg-black/40 flex items-center justify-center relative">
                       <Music className="w-6 h-6 text-zinc-800" />
                       <div className="absolute inset-0 bg-purple-500/0 group-hover:bg-purple-500/10 transition-colors" />
                       <button className="absolute top-1 right-1 p-1 bg-black/80 rounded opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => recordPlay(song.id)}>
                          <Download className="w-3 h-3 text-zinc-400 hover:text-white" />
                       </button>
                    </div>
                 )}
                 
                 <div className={`p-1.5 flex flex-col gap-0.5 ${viewMode === 'list' ? 'flex-1 min-w-0' : ''}`}>
                    <div className="flex items-center justify-between overflow-hidden">
                       <span className="font-bold text-[10px] truncate pr-2 text-zinc-200">
                          {song.name}
                       </span>
                       <button onClick={() => toggleFavorite(song.id)}>{song.favorite && <Star className="w-2 h-2 text-yellow-500 fill-current flex-shrink-0" />}</button>
                    </div>
                    <div className="flex items-center justify-between">
                       <span className="mono-label !text-[8px] !text-zinc-500 truncate">{song.type}</span>
                       <div className="flex items-center gap-3 flex-shrink-0">
                          <span className="text-[8px] font-mono text-zinc-600">{song.length}</span>
                          {viewMode === 'list' && (
                             <div className="flex gap-1">
                                <button className="p-1 hover:bg-white/10 rounded" onClick={() => recordPlay(song.id)}><Play className="w-2.5 h-2.5 text-zinc-400 group-hover:text-purple-400" /></button>
                                <button className="p-1 hover:bg-white/10 rounded" onClick={() => toggleFavorite(song.id)}><Download className="w-2.5 h-2.5 text-zinc-600 hover:text-white" /></button>
                                <button className="p-1 hover:bg-white/10 rounded" onClick={() => removeSong(song.id)}><MoreVertical className="w-2.5 h-2.5 text-zinc-700" /></button>
                             </div>
                          )}
                       </div>
                    </div>
                 </div>
              </div>
            ))}
         </div>

         {filteredSongs.length === 0 && (
            <div className="py-8 flex flex-col items-center justify-center opacity-20 italic">
               <Database className="w-8 h-8 mb-2" />
               <p>No results found</p>
            </div>
         )}
      </Section>

      <Section title="AUDIO ANALYSIS [BETA]" icon={Activity} defaultOpen={false}>
          <div className="space-y-3 p-1">
              <div className="flex flex-col gap-1">
                 <div className="flex justify-between items-center"><span className="mono-label">Target BPM</span><span className="mono-label text-zinc-300">124.00</span></div>
                 <input type="range" className="pro-slider" defaultValue="62" />
              </div>
              <div className="flex flex-col gap-1">
                 <label className="mono-label">Scale / Key Guidance</label>
                 <select className="compact-input w-full uppercase font-mono text-[9px]"><option>C MINOR</option><option>A MAJOR</option></select>
              </div>
              <div className="flex items-center gap-2">
                 <div className="flex-1 p-2 bg-black/40 rounded border border-white/5 flex flex-col items-center">
                    <span className="text-[8px] text-zinc-600 uppercase">Energy</span>
                    <span className="font-bold text-white uppercase italic">High</span>
                 </div>
                 <div className="flex-1 p-2 bg-black/40 rounded border border-white/5 flex flex-col items-center">
                    <span className="text-[8px] text-zinc-600 uppercase">Clarity</span>
                    <span className="font-bold text-white uppercase italic">98%</span>
                 </div>
              </div>
          </div>
      </Section>

    </div>
  );
};
