import React, { useState, useEffect, useMemo, Component, ReactNode } from 'react';
import { 
  auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged,
  collection, doc, setDoc, getDoc, addDoc, query, where, onSnapshot, orderBy, serverTimestamp 
} from './firebase';
import { 
  WashingMachine, Car, Utensils, MessageSquare, PlusCircle, LogOut, 
  User as UserIcon, Home, Send, X, Filter, ChevronRight, Loader2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---

interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  createdAt: any;
}

interface Ad {
  id: string;
  authorId: string;
  authorName: string;
  category: 'washing_machine' | 'transport' | 'meal';
  title: string;
  description: string;
  date?: string;
  time?: string;
  createdAt: any;
}

interface Message {
  id: string;
  adId: string;
  senderId: string;
  senderName: string;
  receiverId: string;
  content: string;
  createdAt: any;
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

// --- Error Handling ---

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean, error: any }> {
  state = { hasError: false, error: null };
  declare props: { children: ReactNode };

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      let message = "Une erreur est survenue.";
      try {
        const parsed = JSON.parse(this.state.error.message);
        if (parsed && typeof parsed === 'object' && parsed.error && parsed.error.includes('Missing or insufficient permissions')) {
          message = "Vous n'avez pas les permissions nécessaires pour cette action.";
        }
      } catch (e) {
        // Not JSON
      }
      return (
        <div className="min-h-screen flex items-center justify-center bg-stone-100 p-4">
          <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full text-center">
            <h2 className="text-2xl font-bold text-stone-900 mb-4">Oups !</h2>
            <p className="text-stone-600 mb-6">{message}</p>
            <button 
              onClick={() => window.location.reload()}
              className="bg-emerald-600 text-white px-6 py-2 rounded-full font-medium hover:bg-emerald-700 transition-colors"
            >
              Recharger l'application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Components ---

const CategoryIcon = ({ category, size = 24 }: { category: string, size?: number }) => {
  switch (category) {
    case 'washing_machine': return <WashingMachine size={size} />;
    case 'transport': return <Car size={size} />;
    case 'meal': return <Utensils size={size} />;
    default: return null;
  }
};

const CategoryLabel = ({ category }: { category: string }) => {
  switch (category) {
    case 'washing_machine': return "Machine à laver";
    case 'transport': return "Transport";
    case 'meal': return "Plat du jour";
    default: return "";
  }
};

export default function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'home' | 'post' | 'messages' | 'profile'>('home');
  const [ads, setAds] = useState<Ad[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeChat, setActiveChat] = useState<{ adId: string, otherUserId: string } | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [selectedAd, setSelectedAd] = useState<Ad | null>(null);
  const [messageContent, setMessageContent] = useState("");
  const chatEndRef = React.useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (view === 'chat') scrollToBottom();
  }, [messages, view]);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
        if (!userDoc.exists()) {
          const newUser: UserProfile = {
            uid: firebaseUser.uid,
            displayName: firebaseUser.displayName || 'Voisin',
            email: firebaseUser.email || '',
            photoURL: firebaseUser.photoURL || '',
            createdAt: serverTimestamp(),
          };
          await setDoc(doc(db, 'users', firebaseUser.uid), newUser);
          setUser(newUser);
        } else {
          setUser(userDoc.data() as UserProfile);
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Ads Listener
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'ads'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const adsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Ad));
      setAds(adsData);
    }, (error) => handleFirestoreError(error, OperationType.LIST, 'ads'));
    return () => unsubscribe();
  }, [user]);

  // Messages Listener (Sent and Received)
  useEffect(() => {
    if (!user) return;
    
    // Using array-contains on participants is more efficient and avoids multiple listeners
    const q = query(
      collection(db, 'messages'), 
      where('participants', 'array-contains', user.uid),
      orderBy('createdAt', 'asc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Message));
      setMessages(msgsData);
    }, (error) => {
      // If index is missing, fallback to unsorted query and sort in memory
      if (error.message.includes('index')) {
        const fallbackQ = query(
          collection(db, 'messages'), 
          where('participants', 'array-contains', user.uid)
        );
        onSnapshot(fallbackQ, (s) => {
          const data = s.docs.map(d => ({ id: d.id, ...d.data() } as Message));
          setMessages(data.sort((a, b) => (a.createdAt?.toDate?.()?.getTime() || 0) - (b.createdAt?.toDate?.()?.getTime() || 0)));
        });
      } else {
        handleFirestoreError(error, OperationType.LIST, 'messages');
      }
    });

    return () => unsubscribe();
  }, [user]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login error", error);
    }
  };

  const handleLogout = () => signOut(auth);

  const handlePostAd = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user) return;
    const formData = new FormData(e.currentTarget);
    const newAd = {
      authorId: user.uid,
      authorName: user.displayName,
      category: formData.get('category') as any,
      title: formData.get('title') as string,
      description: formData.get('description') as string,
      date: formData.get('date') as string,
      time: formData.get('time') as string,
      createdAt: serverTimestamp(),
    };
    try {
      await addDoc(collection(db, 'ads'), newAd);
      setView('home');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'ads');
    }
  };

  const handleSendMessage = async (isReply = false, replyAdId?: string, replyReceiverId?: string, customContent?: string) => {
    const adId = isReply ? replyAdId : selectedAd?.id;
    const receiverId = isReply ? replyReceiverId : selectedAd?.authorId;
    const content = customContent || messageContent;

    if (!user || !adId || !receiverId || !content.trim()) return;

    const newMessage = {
      adId: adId,
      senderId: user.uid,
      senderName: user.displayName,
      receiverId: receiverId,
      participants: [user.uid, receiverId],
      content: content,
      createdAt: serverTimestamp(),
    };
    try {
      await addDoc(collection(db, 'messages'), newMessage);
      if (!customContent) setMessageContent("");
      if (!isReply) {
        setSelectedAd(null);
        setActiveChat({ adId, otherUserId: receiverId });
        setView('messages');
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'messages');
    }
  };

  const conversations = useMemo(() => {
    if (!user) return [];
    const groups: Record<string, { adId: string, otherUserId: string, otherUserName: string, lastMessage: Message, adTitle: string }> = {};
    
    messages.forEach(msg => {
      const otherUserId = msg.senderId === user.uid ? msg.receiverId : msg.senderId;
      const otherUserName = msg.senderId === user.uid ? (ads.find(a => a.id === msg.adId)?.authorName || 'Voisin') : msg.senderName;
      const adTitle = ads.find(a => a.id === msg.adId)?.title || 'Annonce';
      const key = `${msg.adId}_${otherUserId}`;
      
      if (!groups[key] || (msg.createdAt?.toDate?.()?.getTime() || 0) > (groups[key].lastMessage.createdAt?.toDate?.()?.getTime() || 0)) {
        groups[key] = { adId: msg.adId, otherUserId, otherUserName, lastMessage: msg, adTitle };
      }
    });
    
    return Object.values(groups).sort((a, b) => {
      const timeA = a.lastMessage.createdAt?.toDate?.()?.getTime() || 0;
      const timeB = b.lastMessage.createdAt?.toDate?.()?.getTime() || 0;
      return timeB - timeA;
    });
  }, [messages, user, ads]);

  const activeChatMessages = useMemo(() => {
    if (!activeChat || !user) return [];
    return messages.filter(msg => 
      msg.adId === activeChat.adId && 
      ((msg.senderId === user.uid && msg.receiverId === activeChat.otherUserId) || 
       (msg.senderId === activeChat.otherUserId && msg.receiverId === user.uid))
    );
  }, [messages, activeChat, user]);

  const filteredAds = useMemo(() => {
    return filter ? ads.filter(ad => ad.category === filter) : ads;
  }, [ads, filter]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <Loader2 className="animate-spin text-emerald-600" size={48} />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full text-center"
        >
          <div className="mb-8 flex justify-center">
            <div className="bg-emerald-100 p-6 rounded-full">
              <Home className="text-emerald-600" size={64} />
            </div>
          </div>
          <h1 className="text-4xl font-bold text-stone-900 mb-2 font-serif italic">Voisinage Solidaire</h1>
          <p className="text-emerald-600 font-medium mb-6 italic">"Ensemble, partageons plus, dépensons moins :-)"</p>
          <p className="text-stone-600 mb-10 text-lg">Connectez-vous avec vos voisins pour partager des services et renforcer les liens locaux.</p>
          <button 
            onClick={handleLogin}
            className="w-full bg-emerald-600 text-white py-4 rounded-2xl font-semibold text-lg shadow-lg hover:bg-emerald-700 transition-all flex items-center justify-center gap-3"
          >
            <UserIcon size={24} />
            Se connecter avec Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-stone-50 pb-24">
        {/* Header */}
        <header className="bg-white border-b border-stone-200 sticky top-0 z-30 px-4 py-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-stone-900 font-serif italic leading-none">Voisinage</h1>
              <p className="text-[10px] text-emerald-600 font-medium italic mt-1">Ensemble, partageons plus, dépensons moins :-)</p>
            </div>
            <div className="flex items-center gap-4">
              <button 
                onClick={() => setView('messages')}
                className="relative p-2 text-stone-600 hover:bg-stone-100 rounded-full transition-colors"
              >
                <MessageSquare size={24} />
                {messages.length > 0 && (
                  <span className="absolute top-0 right-0 bg-red-500 text-white text-[10px] font-bold w-4 h-4 flex items-center justify-center rounded-full">
                    {messages.length}
                  </span>
                )}
              </button>
              <button 
                onClick={handleLogout}
                className="p-2 text-stone-600 hover:bg-stone-100 rounded-full transition-colors"
              >
                <LogOut size={24} />
              </button>
            </div>
          </div>
        </header>

        <main className="max-w-4xl mx-auto p-4">
          <AnimatePresence mode="wait">
            {view === 'home' && (
              <motion.div 
                key="home"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {/* Filters */}
                <div className="flex gap-2 overflow-x-auto pb-4 mb-6 no-scrollbar">
                  <button 
                    onClick={() => setFilter(null)}
                    className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all ${!filter ? 'bg-emerald-600 text-white' : 'bg-white text-stone-600 border border-stone-200'}`}
                  >
                    Tous
                  </button>
                  {['washing_machine', 'transport', 'meal'].map(cat => (
                    <button 
                      key={cat}
                      onClick={() => setFilter(cat)}
                      className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap flex items-center gap-2 transition-all ${filter === cat ? 'bg-emerald-600 text-white' : 'bg-white text-stone-600 border border-stone-200'}`}
                    >
                      <CategoryIcon category={cat} size={16} />
                      <CategoryLabel category={cat} />
                    </button>
                  ))}
                </div>

                {/* Ads List */}
                <div className="grid gap-4">
                  {filteredAds.length === 0 ? (
                    <div className="text-center py-20 text-stone-400">
                      <Filter size={48} className="mx-auto mb-4 opacity-20" />
                      <p>Aucune annonce pour le moment.</p>
                    </div>
                  ) : (
                    filteredAds.map(ad => {
                      const isAuthor = ad.authorId === user.uid;
                      const hasConversation = conversations.some(c => c.adId === ad.id);

                      return (
                        <motion.div 
                          layout
                          key={ad.id}
                          className="bg-white p-5 rounded-2xl border border-stone-200 shadow-sm hover:shadow-md transition-shadow"
                        >
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex items-center gap-3">
                              <div className="bg-emerald-50 p-3 rounded-xl text-emerald-600">
                                <CategoryIcon category={ad.category} />
                              </div>
                              <div>
                                <h3 className="font-bold text-stone-900 text-lg">{ad.title}</h3>
                                <p className="text-xs text-stone-400 uppercase tracking-wider font-semibold">
                                  {ad.authorName} • {new Date(ad.createdAt?.toDate()).toLocaleDateString()}
                                </p>
                                {(ad.date || ad.time) && (
                                  <p className="text-xs text-emerald-600 font-bold mt-1">
                                    📅 {ad.date ? new Date(ad.date).toLocaleDateString() : ''} {ad.time ? `à ${ad.time}` : ''}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                          <p className="text-stone-600 mb-4 line-clamp-3">{ad.description}</p>
                          
                          {isAuthor ? (
                            hasConversation && (
                              <button 
                                onClick={() => {
                                  const firstConv = conversations.find(c => c.adId === ad.id);
                                  if (firstConv) {
                                    setActiveChat({ adId: ad.id, otherUserId: firstConv.otherUserId });
                                    setView('messages');
                                  }
                                }}
                                className="w-full bg-emerald-50 text-emerald-700 py-3 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-emerald-100 transition-colors"
                              >
                                <MessageSquare size={18} />
                                Voir les réponses
                              </button>
                            )
                          ) : (
                            <button 
                              onClick={() => {
                                if (hasConversation) {
                                  setActiveChat({ adId: ad.id, otherUserId: ad.authorId });
                                  setView('messages');
                                } else {
                                  setSelectedAd(ad);
                                }
                              }}
                              className="w-full bg-stone-900 text-white py-3 rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-stone-800 transition-colors"
                            >
                              <MessageSquare size={18} />
                              {hasConversation ? "Continuer la discussion" : "Contacter le voisin"}
                            </button>
                          )}
                        </motion.div>
                      );
                    })
                  )}
                </div>
              </motion.div>
            )}

            {view === 'post' && (
              <motion.div 
                key="post"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="bg-white p-6 rounded-3xl border border-stone-200 shadow-xl"
              >
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-2xl font-bold text-stone-900 font-serif italic">Nouvelle annonce</h2>
                  <button onClick={() => setView('home')} className="text-stone-400 hover:text-stone-600">
                    <X size={24} />
                  </button>
                </div>
                <form onSubmit={handlePostAd} className="space-y-6">
                  <div>
                    <label className="block text-sm font-semibold text-stone-700 mb-2">Catégorie</label>
                    <select 
                      name="category" 
                      required
                      className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
                    >
                      <option value="washing_machine">Machine à laver</option>
                      <option value="transport">Transport en voiture</option>
                      <option value="meal">Plat du jour</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-stone-700 mb-2">Titre</label>
                    <input 
                      name="title" 
                      type="text" 
                      required 
                      placeholder="Ex: Machine à laver dispo ce soir"
                      className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-stone-700 mb-2">Date</label>
                      <input 
                        name="date" 
                        type="date" 
                        required 
                        className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-stone-700 mb-2">Heure</label>
                      <input 
                        name="time" 
                        type="time" 
                        required 
                        className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-stone-700 mb-2">Description</label>
                    <textarea 
                      name="description" 
                      required 
                      rows={4}
                      placeholder="Détails sur votre proposition ou demande..."
                      className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-emerald-500 outline-none transition-all resize-none"
                    ></textarea>
                  </div>
                  <div className="bg-emerald-50 p-4 rounded-2xl border border-emerald-100">
                    <p className="text-emerald-800 font-medium text-center">
                      Tranquille! Vous vous arrangez entre vous, tout simplement, sans intermédiaire ;-)
                    </p>
                  </div>
                  <button 
                    type="submit"
                    className="w-full bg-emerald-600 text-white py-4 rounded-2xl font-bold text-lg shadow-lg hover:bg-emerald-700 transition-all"
                  >
                    Publier l'annonce
                  </button>
                </form>
              </motion.div>
            )}

            {view === 'messages' && (
              <motion.div 
                key="messages"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-[calc(100vh-180px)]"
              >
                <div className="bg-white h-full rounded-3xl border border-stone-200 shadow-sm overflow-hidden flex flex-col md:flex-row">
                  {/* Conversations List */}
                  <div className={`w-full md:w-80 border-r border-stone-100 flex flex-col ${activeChat ? 'hidden md:flex' : 'flex'}`}>
                    <div className="p-6 border-b border-stone-100">
                      <h2 className="text-xl font-bold text-stone-900">Messages</h2>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                      {conversations.length === 0 ? (
                        <div className="p-10 text-center text-stone-400">
                          <MessageSquare size={32} className="mx-auto mb-3 opacity-20" />
                          <p className="text-sm">Aucune discussion</p>
                        </div>
                      ) : (
                        conversations.map(conv => {
                          const isActive = activeChat?.adId === conv.adId && activeChat?.otherUserId === conv.otherUserId;
                          return (
                            <button
                              key={`${conv.adId}-${conv.otherUserId}`}
                              onClick={() => setActiveChat({ adId: conv.adId, otherUserId: conv.otherUserId })}
                              className={`w-full p-4 flex items-start gap-3 transition-colors text-left border-b border-stone-50 ${isActive ? 'bg-emerald-50' : 'hover:bg-stone-50'}`}
                            >
                              <div className="w-10 h-10 bg-stone-100 rounded-full flex items-center justify-center text-stone-400 shrink-0">
                                <UserIcon size={20} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex justify-between items-baseline mb-1">
                                  <p className="font-bold text-stone-900 text-sm truncate">{conv.otherUserName}</p>
                                  <span className="text-[10px] text-stone-400">
                                    {new Date(conv.lastMessage.createdAt?.toDate()).toLocaleDateString([], { day: '2-digit', month: '2-digit' })}
                                  </span>
                                </div>
                                <p className="text-xs text-emerald-600 font-bold truncate mb-1">{conv.adTitle}</p>
                                <p className="text-xs text-stone-500 truncate">{conv.lastMessage.content}</p>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* Chat Area */}
                  <div className={`flex-1 flex flex-col bg-stone-50 ${!activeChat ? 'hidden md:flex items-center justify-center' : 'flex'}`}>
                    {activeChat ? (
                      <>
                        {/* Chat Header */}
                        <div className="p-4 bg-white border-b border-stone-100 flex items-center gap-3">
                          <button onClick={() => setActiveChat(null)} className="md:hidden text-stone-400">
                            <ChevronRight size={24} className="rotate-180" />
                          </button>
                          <div className="w-8 h-8 bg-stone-100 rounded-full flex items-center justify-center text-stone-400">
                            <UserIcon size={16} />
                          </div>
                          <div>
                            <p className="font-bold text-stone-900 text-sm">
                              {conversations.find(c => c.adId === activeChat.adId && c.otherUserId === activeChat.otherUserId)?.otherUserName}
                            </p>
                            <p className="text-[10px] text-emerald-600 font-bold uppercase tracking-wider">
                              {conversations.find(c => c.adId === activeChat.adId && c.otherUserId === activeChat.otherUserId)?.adTitle}
                            </p>
                          </div>
                        </div>

                        {/* Messages */}
                        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[#e5ddd5]/30">
                          {messages
                            .filter(msg => 
                              msg.adId === activeChat.adId && 
                              ((msg.senderId === user?.uid && msg.receiverId === activeChat.otherUserId) || 
                               (msg.senderId === activeChat.otherUserId && msg.receiverId === user?.uid))
                            )
                            .map((msg) => {
                              const isMe = msg.senderId === user?.uid;
                              return (
                                <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                                  <div className={`max-w-[80%] px-4 py-2 rounded-2xl shadow-sm text-sm ${isMe ? 'bg-emerald-600 text-white rounded-tr-none' : 'bg-white text-stone-800 rounded-tl-none'}`}>
                                    <p>{msg.content}</p>
                                    <div className={`text-[10px] mt-1 ${isMe ? 'text-emerald-100' : 'text-stone-400'} text-right`}>
                                      {new Date(msg.createdAt?.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          <div ref={chatEndRef} />
                        </div>

                        {/* Input */}
                        <div className="p-4 bg-white border-t border-stone-100">
                          <div className="flex items-center gap-2">
                            <input 
                              type="text"
                              value={messageContent}
                              onChange={(e) => setMessageContent(e.target.value)}
                              onKeyPress={(e) => e.key === 'Enter' && handleSendMessage(true, activeChat.adId, activeChat.otherUserId)}
                              placeholder="Écrivez votre message..."
                              className="flex-1 bg-stone-50 border border-stone-200 rounded-full px-4 py-3 text-sm focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
                            />
                            <button 
                              onClick={() => handleSendMessage(true, activeChat.adId, activeChat.otherUserId)}
                              disabled={!messageContent.trim()}
                              className="bg-emerald-600 text-white p-3 rounded-full shadow-lg hover:bg-emerald-700 transition-all active:scale-95 disabled:opacity-50"
                            >
                              <Send size={20} />
                            </button>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="text-center text-stone-400">
                        <MessageSquare size={64} className="mx-auto mb-4 opacity-10" />
                        <p>Sélectionnez une discussion pour commencer</p>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {view === 'profile' && (
              <motion.div 
                key="profile"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="max-w-2xl mx-auto"
              >
                <div className="bg-white p-8 rounded-3xl border border-stone-200 shadow-sm text-center">
                  <div className="w-24 h-24 bg-stone-100 rounded-full flex items-center justify-center mx-auto mb-6 text-stone-400">
                    <UserIcon size={48} />
                  </div>
                  <h2 className="text-2xl font-bold text-stone-900 mb-2">{user?.displayName}</h2>
                  <p className="text-stone-500 mb-8">{user?.email}</p>
                  
                  <div className="grid grid-cols-2 gap-4 mb-8">
                    <div className="bg-stone-50 p-4 rounded-2xl">
                      <p className="text-2xl font-bold text-stone-900">{ads.filter(a => a.authorId === user?.uid).length}</p>
                      <p className="text-xs text-stone-400 uppercase font-bold tracking-widest">Annonces</p>
                    </div>
                    <div className="bg-stone-50 p-4 rounded-2xl">
                      <p className="text-2xl font-bold text-stone-900">{conversations.length}</p>
                      <p className="text-xs text-stone-400 uppercase font-bold tracking-widest">Discussions</p>
                    </div>
                  </div>

                  <button 
                    onClick={handleLogout}
                    className="w-full bg-stone-100 text-stone-600 py-4 rounded-2xl font-bold hover:bg-stone-200 transition-colors"
                  >
                    Se déconnecter
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Navigation Bar */}
        <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-stone-200 px-6 py-3 z-40">
          <div className="max-w-md mx-auto flex items-center justify-around">
            <button 
              onClick={() => setView('home')}
              className={`flex flex-col items-center gap-1 transition-colors ${view === 'home' ? 'text-emerald-600' : 'text-stone-400'}`}
            >
              <Home size={24} />
              <span className="text-[10px] font-bold uppercase tracking-widest">Accueil</span>
            </button>
            <button 
              onClick={() => setView('post')}
              className="bg-emerald-600 text-white p-4 rounded-full -mt-10 shadow-xl hover:scale-110 transition-transform"
            >
              <PlusCircle size={28} />
            </button>
            <button 
              onClick={() => setView('messages')}
              className={`flex flex-col items-center gap-1 transition-colors ${view === 'messages' ? 'text-emerald-600' : 'text-stone-400'}`}
            >
              <MessageSquare size={24} />
              <span className="text-[10px] font-bold uppercase tracking-widest">Messages</span>
            </button>
            <button 
              onClick={() => setView('profile')}
              className={`flex flex-col items-center gap-1 transition-colors ${view === 'profile' ? 'text-emerald-600' : 'text-stone-400'}`}
            >
              <UserIcon size={24} />
              <span className="text-[10px] font-bold uppercase tracking-widest">Profil</span>
            </button>
          </div>
        </nav>

        {/* Contact Modal */}
        <AnimatePresence>
          {selectedAd && (
            <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setSelectedAd(null)}
                className="absolute inset-0 bg-stone-900/60 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, y: 100 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 100 }}
                className="bg-white w-full max-w-lg rounded-t-3xl sm:rounded-3xl p-6 relative z-10 shadow-2xl"
              >
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h3 className="text-xl font-bold text-stone-900">Contacter {selectedAd.authorName}</h3>
                    <p className="text-sm text-stone-500">À propos de : {selectedAd.title}</p>
                  </div>
                  <button onClick={() => setSelectedAd(null)} className="text-stone-400">
                    <X size={24} />
                  </button>
                </div>
                <textarea 
                  value={messageContent}
                  onChange={(e) => setMessageContent(e.target.value)}
                  placeholder="Bonjour, je suis intéressé par votre annonce..."
                  rows={4}
                  className="w-full bg-stone-50 border border-stone-200 rounded-2xl px-4 py-3 focus:ring-2 focus:ring-emerald-500 outline-none transition-all resize-none mb-6"
                ></textarea>
                <button 
                  onClick={() => handleSendMessage(false)}
                  disabled={!messageContent.trim()}
                  className="w-full bg-emerald-600 text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-emerald-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Send size={20} />
                  Envoyer le message
                </button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </ErrorBoundary>
  );
}
