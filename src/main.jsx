import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import OrderManagerWindow from './components/OrderManagerWindow.jsx'

const isOrderManager = window.location.hash === '#order-manager';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isOrderManager ? <OrderManagerWindow /> : <App />}
  </StrictMode>,
)
