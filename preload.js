'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  contacts: {
    list:   ()        => ipcRenderer.invoke('contacts:list'),
    save:   (contact) => ipcRenderer.invoke('contacts:save', contact),
    delete: (email)   => ipcRenderer.invoke('contacts:delete', email),
    suggestions:     ()       => ipcRenderer.invoke('contacts:suggestions'),
    saveSuggestions: (record) => ipcRenderer.invoke('contacts:suggestions-save', record),
  },
  opps: {
    list:    ()    => ipcRenderer.invoke('opps:list'),
    save:    (opp) => ipcRenderer.invoke('opps:save', opp),
    delete:  (id)  => ipcRenderer.invoke('opps:delete', id),
    refresh: ()    => ipcRenderer.invoke('opps:refresh'),
  },
  settings: {
    get:  ()        => ipcRenderer.invoke('settings:get'),
    save: (updates) => ipcRenderer.invoke('settings:save', updates),
  },
  profile: {
    get:  ()        => ipcRenderer.invoke('profile:get'),
    save: (updates) => ipcRenderer.invoke('profile:save', updates),
  },
  courses: {
    list:   ()       => ipcRenderer.invoke('courses:list'),
    save:   (course) => ipcRenderer.invoke('courses:save', course),
    delete: (id)     => ipcRenderer.invoke('courses:delete', id),
  },
  files: {
    pickText: () => ipcRenderer.invoke('files:pick-text'),
  },
  companies: {
    list: () => ipcRenderer.invoke('companies:list'),
  },
  forecast: {
    get:      () => ipcRenderer.invoke('forecast:get'),
    generate: () => ipcRenderer.invoke('ai:forecast'),
  },
  ai: {
    research: (contact)                 => ipcRenderer.invoke('ai:research', contact),
    draft:    (contact, research, tone) => ipcRenderer.invoke('ai:draft', { contact, research, tone }),
    match:    ()                        => ipcRenderer.invoke('ai:match'),
    courseRole:     (role)              => ipcRenderer.invoke('ai:course-role', role),
    courseSyllabus: (text, name)        => ipcRenderer.invoke('ai:course-syllabus', { text, name }),
    lesson: (courseId, moduleIdx, lessonIdx) =>
      ipcRenderer.invoke('ai:lesson', { courseId, moduleIdx, lessonIdx }),
    quiz: (courseId, moduleIdx, lessonIdx) =>
      ipcRenderer.invoke('ai:quiz', { courseId, moduleIdx, lessonIdx }),
    companyResearch:   (name) => ipcRenderer.invoke('ai:company-research', name),
    recommendContacts: ()     => ipcRenderer.invoke('ai:recommend-contacts'),
    companyLeads:    (name) => ipcRenderer.invoke('ai:company-leads', name),
    resumeFeedback:  ()     => ipcRenderer.invoke('ai:resume-feedback'),
    scanMe:          ()     => ipcRenderer.invoke('ai:scan-me'),
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onContactsChanged: (cb) => ipcRenderer.on('contacts-changed', cb),
});
